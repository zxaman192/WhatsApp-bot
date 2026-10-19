import { PDFDocument } from 'pdf-lib';
import * as store from '../db.js';
import { SUBJECTS, findSubjectIn } from '../subjects.js';
import { parseFormattedMcqs } from './textParser.js';
import { classify } from './keywords.js';
import { imageBlock, pdfBlock, textBlock } from './claude.js';
import { aiAvailable, extract } from './ai.js';

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

  if (!aiAvailable()) {
    await ingestWithoutAi({ kind, buffer, hint, save, summary });
    return summary;
  }

  if (kind === 'text') {
    const text = buffer.toString('utf8');
    // Already-formatted MCQs with a subject in the caption don't need AI.
    const parsed = parseFormattedMcqs(text);
    const hintSubject = findSubjectIn(hint);
    if (hintSubject && parsed.questions.length > 0 && parsed.skipped <= parsed.questions.length * 0.2) {
      await save({ questions: offlineQuestions(parsed.questions, { hintSubject }).questions });
      summary.skipped += parsed.skipped;
      return summary;
    }
    summary.usedAi = true;
    const chunks = textChunks(text);
    for (let i = 0; i < chunks.length; i++) {
      if (chunks.length > 1) await onProgress(`Reading part ${i + 1} of ${chunks.length}…`);
      try {
        await save(await extract([textBlock(chunks[i])], { hint, existingTopics: await store.existingTopics() }));
      } catch (e) {
        summary.errors.push(`Part ${i + 1}: ${e.message}`);
      }
    }
    return summary;
  }

  summary.usedAi = true;

  if (kind === 'image') {
    try {
      await save(await extract([imageBlock(buffer, mimeType)], { hint, existingTopics: await store.existingTopics() }));
    } catch (e) {
      summary.errors.push(e.message);
    }
    return summary;
  }

  for await (const chunk of pdfChunks(buffer)) {
    if (chunk.total > PAGES_PER_CHUNK) await onProgress(`Reading pages ${chunk.firstPage}-${chunk.lastPage} of ${chunk.total}…`);
    try {
      const result = await extract([pdfBlock(chunk.buffer)], { hint, existingTopics: await store.existingTopics() });
      await save(result, chunk.firstPage - 1);
    } catch (e) {
      summary.errors.push(`Pages ${chunk.firstPage}-${chunk.lastPage}: ${e.message}`);
    }
  }
  return summary;
}

/** Text of each page of a PDF (empty strings for scanned pages). */
export async function pdfPages(buffer) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}

/** Give parsed MCQs a subject/topic (caption first, then keywords) and the same shape Claude returns. */
function offlineQuestions(parsed, { hintSubject = null, fallbackSubject = 'Medicine', pageOfLine = null }) {
  let unsorted = 0;
  const questions = parsed.map((q) => {
    // The stem says what the question is about; options often name things from other chapters.
    const guess = classify(`${q.stem} ${q.explanation}`) || classify(q.options.join(' '));
    let subject = hintSubject || guess?.subject;
    if (!subject) { subject = fallbackSubject; unsorted++; }
    const topic = guess && guess.subject === subject ? guess.topic : 'General';
    return {
      ...q,
      subject,
      topic,
      answer_index: q.answer,
      answer_given_in_source: true,
      origin: q.year ? 'pyq' : 'bank',
      page: pageOfLine ? pageOfLine[q.line] || 0 : 0,
    };
  });
  return { questions, unsorted };
}

/**
 * No Claude key: read text (and PDFs that contain real text), pull out numbered MCQs with an
 * answer (inline or from an answer key), and sort them by caption or keywords. If there are no MCQs,
 * store the text as notes, page by page, so "explain" and "where" can find it.
 */
async function ingestWithoutAi({ kind, buffer, hint, save, summary }) {
  if (kind === 'image') {
    summary.errors.push('Reading photos needs an AI key (Gemini or Claude), which is not set up yet. Text and PDFs with selectable text work without it.');
    return;
  }
  let pages;
  if (kind === 'pdf') {
    try {
      pages = await pdfPages(buffer);
    } catch (e) {
      summary.errors.push(`Couldn't open this PDF: ${e.message}`);
      return;
    }
    const chars = pages.reduce((n, p) => n + p.trim().length, 0);
    if (chars < pages.length * 40) {
      summary.errors.push('This PDF looks scanned (no selectable text). Reading scans needs an AI key (Gemini or Claude).');
      return;
    }
  } else {
    pages = [buffer.toString('utf8')];
  }

  // Join pages, remembering which page each line came from.
  const pageOfLine = [];
  const lines = [];
  pages.forEach((p, i) => {
    for (const l of p.split('\n')) { lines.push(l); pageOfLine.push(kind === 'pdf' ? i + 1 : 0); }
  });
  const text = lines.join('\n');
  const hintSubject = findSubjectIn(hint);
  const docGuess = classify(text);
  const parsed = parseFormattedMcqs(text);

  if (parsed.questions.length) {
    const { questions, unsorted } = offlineQuestions(parsed.questions, {
      hintSubject,
      fallbackSubject: docGuess?.subject || 'Medicine',
      pageOfLine,
    });
    await save({ questions });
    summary.skipped += parsed.skipped;
    if (unsorted && !hintSubject) {
      summary.errors.push(`${unsorted} couldn't be sorted by keywords and went under ${docGuess?.subject || 'Medicine'}. A caption like "pharma" fixes that.`);
    }
    if (parsed.skipped) summary.errors.push('Questions with no answer marked (inline or in an answer key) were skipped; an AI key (Gemini or Claude) can work those out.');
    return;
  }

  // No MCQs: keep it as notes, one entry per page (or ~2000-character piece of text).
  const pieces = kind === 'pdf' ? pages.map((p, i) => ({ text: p, page: i + 1 })) : textChunks(text).flatMap((c) => splitNotes(c).map((t) => ({ text: t, page: 0 })));
  const notes = [];
  for (const piece of pieces) {
    const body = piece.text.replace(/[ \t]+/g, ' ').trim();
    if (body.length < 40) continue;
    const guess = classify(body);
    const subject = hintSubject || guess?.subject || docGuess?.subject;
    if (!subject) continue;
    notes.push({ subject, topic: guess && guess.subject === subject ? guess.topic : 'General', content: body, page: piece.page });
  }
  if (!notes.length) {
    summary.errors.push(`I found no MCQs with answers, and couldn't tell the subject of these notes. Send it again with a caption like "pharma".`);
    return;
  }
  await save({ notes });
  summary.errors.push('Saved as notes (no AI key, so no questions were written from them).');
}

function splitNotes(text, size = 2000) {
  const out = [];
  let cur = '';
  for (const para of text.split(/\n\s*\n/)) {
    if (cur && cur.length + para.length > size) { out.push(cur); cur = ''; }
    cur += (cur ? '\n\n' : '') + para;
  }
  if (cur.trim()) out.push(cur);
  return out;
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
