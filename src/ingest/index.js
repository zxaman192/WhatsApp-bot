import { PDFDocument } from 'pdf-lib';
import * as store from '../db.js';
import { SUBJECTS, findSubjectIn } from '../subjects.js';
import { parseFormattedMcqs } from './textParser.js';
import { claudeAvailable, extractWithClaude, imageBlock, pdfBlock, textBlock } from './claude.js';

const PAGES_PER_CHUNK = 15;
const TEXT_CHUNK_CHARS = 40000;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** Split a PDF into chunks of N pages. Yields { buffer, firstPage }. */
export async function* pdfChunks(buffer) {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const total = src.getPageCount();
  for (let start = 0; start < total; start += PAGES_PER_CHUNK) {
    const out = await PDFDocument.create();
    const idx = [...Array(Math.min(PAGES_PER_CHUNK, total - start)).keys()].map((i) => start + i);
    for (const p of await out.copyPages(src, idx)) out.addPage(p);
    yield { buffer: Buffer.from(await out.save()), firstPage: start + 1, lastPage: start + idx.length, total };
  }
}

function textChunks(text) {
  const chunks = [];
  let rest = text;
  while (rest.length > TEXT_CHUNK_CHARS) {
    // Cut at a blank line near the limit so questions aren't split in half.
    let cut = rest.lastIndexOf('\n\n', TEXT_CHUNK_CHARS);
    if (cut < TEXT_CHUNK_CHARS / 2) cut = TEXT_CHUNK_CHARS;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

function validQuestion(q) {
  return (
    q &&
    SUBJECTS.includes(q.subject) &&
    q.stem?.trim() &&
    Array.isArray(q.options) &&
    q.options.length === 4 &&
    q.options.every((o) => String(o).trim()) &&
    Number.isInteger(q.answer_index) &&
    q.answer_index >= 0 &&
    q.answer_index < 4
  );
}

/**
 * Read an upload, split it into questions and notes, sort each into subject → topic and save.
 *
 * input: { buffer, mimeType, filename, caption, addedBy, onProgress? }
 * Returns a summary: { questions, duplicates, notes, bySubject: {subject: {topic: count}}, skipped, errors }
 */
export async function ingest({ buffer, mimeType, filename, caption = '', addedBy, onProgress = async () => {} }) {
  const hint = caption || filename || '';
  const kind = mimeType === 'application/pdf' ? 'pdf' : IMAGE_TYPES.includes(mimeType) ? 'image' : 'text';
  const sourceId = await store.addSource(filename || `${kind} upload`, kind, addedBy);
  const summary = { questions: 0, duplicates: 0, notes: 0, bySubject: {}, skipped: 0, errors: [], usedAi: false };

  const tally = (subject, topic, field) => {
    const s = (summary.bySubject[subject] ??= {});
    const t = (s[topic] ??= { questions: 0, notes: 0 });
    t[field]++;
  };

  const save = async (result, pageOffset = 0) => {
    for (const q of result.questions || []) {
      if (!validQuestion(q)) { summary.skipped++; continue; }
      const topic = q.topic?.trim() || 'General';
      const isNew = await store.addQuestion({
        subject: q.subject,
        topic,
        stem: q.stem.trim(),
        options: q.options.map((o) => String(o).trim()),
        answer: q.answer_index,
        explanation: q.explanation || '',
        year: q.year || '',
        exam: q.exam || '',
        answerChecked: q.answer_given_in_source,
        origin: q.origin || 'bank',
        sourceId,
        page: q.page > 0 ? q.page + pageOffset : null,
      });
      if (isNew) { summary.questions++; tally(q.subject, topic, 'questions'); } else summary.duplicates++;
    }
    for (const n of result.notes || []) {
      if (!SUBJECTS.includes(n.subject) || !n.content?.trim()) continue;
      const topic = n.topic?.trim() || 'General';
      await store.addNote({ subject: n.subject, topic, content: n.content.trim(), sourceId, page: n.page > 0 ? n.page + pageOffset : null });
      summary.notes++;
      tally(n.subject, topic, 'notes');
    }
  };

  // Plain text that is already formatted as MCQs with answers doesn't need AI.
  if (kind === 'text') {
    const text = buffer.toString('utf8');
    const parsed = parseFormattedMcqs(text);
    const hintSubject = findSubjectIn(hint);
    const mostlyParsed = parsed.questions.length > 0 && parsed.skipped <= parsed.questions.length * 0.2;
    if (mostlyParsed && (hintSubject || !claudeAvailable())) {
      const subject = hintSubject || 'Medicine';
      await save({
        questions: parsed.questions.map((q) => ({
          ...q,
          subject,
          topic: 'General',
          answer_index: q.answer,
          answer_given_in_source: true,
          origin: q.year ? 'pyq' : 'bank',
          page: 0,
        })),
      });
      summary.skipped += parsed.skipped;
      if (!hintSubject) summary.errors.push('No subject in the caption, so these were filed under Medicine. Add a caption like "pharma" next time.');
      return summary;
    }
    if (!claudeAvailable()) {
      summary.errors.push(
        parsed.questions.length
          ? 'Some questions had no answer marked, and AI reading is not set up (no Claude API key).'
          : 'Could not find numbered MCQs with answers, and AI reading is not set up (no Claude API key).'
      );
      summary.skipped += parsed.skipped;
      return summary;
    }
    summary.usedAi = true;
    const chunks = textChunks(text);
    for (let i = 0; i < chunks.length; i++) {
      if (chunks.length > 1) await onProgress(`Reading part ${i + 1} of ${chunks.length}…`);
      try {
        await save(await extractWithClaude([textBlock(chunks[i])], { hint, existingTopics: await store.existingTopics() }));
      } catch (e) {
        summary.errors.push(`Part ${i + 1}: ${e.message}`);
      }
    }
    return summary;
  }

  if (!claudeAvailable()) {
    summary.errors.push('Reading PDFs and photos needs the Claude API key, which is not set up yet.');
    return summary;
  }
  summary.usedAi = true;

  if (kind === 'image') {
    try {
      await save(await extractWithClaude([imageBlock(buffer, mimeType)], { hint, existingTopics: await store.existingTopics() }));
    } catch (e) {
      summary.errors.push(e.message);
    }
    return summary;
  }

  for await (const chunk of pdfChunks(buffer)) {
    if (chunk.total > PAGES_PER_CHUNK) await onProgress(`Reading pages ${chunk.firstPage}-${chunk.lastPage} of ${chunk.total}…`);
    try {
      const result = await extractWithClaude([pdfBlock(chunk.buffer)], { hint, existingTopics: await store.existingTopics() });
      await save(result, chunk.firstPage - 1);
    } catch (e) {
      summary.errors.push(`Pages ${chunk.firstPage}-${chunk.lastPage}: ${e.message}`);
    }
  }
  return summary;
}

export function formatSummary(summary, filename) {
  const lines = [];
  const name = filename ? `*${filename}*` : 'your upload';
  if (!summary.questions && !summary.notes) {
    lines.push(`I couldn't add anything from ${name}.`);
  } else {
    const parts = [];
    if (summary.questions) parts.push(`${summary.questions} questions`);
    if (summary.notes) parts.push(`${summary.notes} note sections`);
    lines.push(`✅ Added ${parts.join(' and ')} from ${name}, sorted like this:`);
    for (const [subject, topics] of Object.entries(summary.bySubject)) {
      lines.push('', `*${subject}*`);
      for (const [topic, c] of Object.entries(topics)) {
        const bits = [];
        if (c.questions) bits.push(`${c.questions} Q`);
        if (c.notes) bits.push(`${c.notes} notes`);
        lines.push(`- ${topic}: ${bits.join(', ')}`);
      }
    }
  }
  if (summary.duplicates) lines.push('', `${summary.duplicates} were already in your bank, skipped.`);
  if (summary.skipped) lines.push(`${summary.skipped} couldn't be read as complete 4-option questions.`);
  for (const e of summary.errors) lines.push(`⚠️ ${e}`);
  return lines.join('\n');
}
