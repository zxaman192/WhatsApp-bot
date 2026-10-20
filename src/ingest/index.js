import { PDFDocument } from 'pdf-lib';
import * as store from '../db.js';
import { config } from '../config.js';
import { SUBJECTS, findSubjectIn } from '../subjects.js';
import { parseFormattedMcqs, parseAnswerKey } from './textParser.js';
import { classify } from './keywords.js';
import { imageBlock, pdfBlock, textBlock } from './claude.js';
import { aiAvailable, extract, mediaAvailable, AiBusyError } from './ai.js';

// Pages per AI call. Notes are dense: with many pages per call the AI summarises instead of keeping
// every fact, so notes go 4 pages at a time. Question banks have less to write per page.
const NOTE_PAGES = 4;
const QBANK_PAGES = 10;
const PARALLEL_PARTS = 3;
const TEXT_CHUNK_CHARS = 40000;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** Split a PDF into chunks of N pages. Yields { buffer, firstPage, lastPage, total }. */
export async function* pdfChunks(buffer, size = 15) {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const total = src.getPageCount();
  for (let start = 1; start <= total; start += size) {
    const last = Math.min(total, start + size - 1);
    yield { buffer: await subPdf(src, start, last), firstPage: start, lastPage: last, total };
  }
}

/** Pages from..to (1-based, inclusive) of a loaded PDF as a new PDF. */
async function subPdf(src, from, to) {
  const out = await PDFDocument.create();
  const idx = Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
  for (const p of await out.copyPages(src, idx)) out.addPage(p);
  return Buffer.from(await out.save());
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

const canon = (t) => String(t).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').replace(/\b(\w{3,}?)s\b/g, '$1').trim();
const titleCase = (t) => t.replace(/\b([a-z])/g, (c) => c.toUpperCase());

/**
 * Saves AI or parser results: validates questions, normalises PYQ years and topic names (so parallel
 * parts don't create "ANS" and "Autonomic Nervous System"), applies a file-wide answer key, and tallies.
 */
function makeSaver({ sourceId, summary, topics, answerKey = {} }) {
  const tally = (subject, topic, field) => {
    const s = (summary.bySubject[subject] ??= {});
    const t = (s[topic] ??= { questions: 0, notes: 0 });
    t[field]++;
  };
  const topicFor = (subject, raw) => {
    const name = String(raw || '').trim() || 'General';
    const known = (topics[subject] ??= []);
    const hit = known.find((k) => canon(k) === canon(name));
    if (hit) return hit;
    const fresh = /[A-Z]/.test(name.slice(1)) ? name : titleCase(name);
    known.push(fresh);
    return fresh;
  };
  return async (result, pageOffset = 0) => {
    for (const q of result.questions || []) {
      if (!validQuestion(q)) { summary.skipped++; continue; }
      const topic = topicFor(q.subject, q.topic);
      let answer = q.answer_index;
      let checked = Boolean(q.answer_given_in_source);
      const keyed = q.number != null && answerKey[String(q.number).replace(/\D/g, '')];
      if (keyed != null && keyed !== false && keyed >= 0) { answer = keyed; checked = true; }
      if (/^\s*disputed key/i.test(q.explanation || '')) checked = false;
      const year = (String(q.year || '').match(/(19|20)\d{2}/) || [''])[0];
      const isNew = await store.addQuestion({
        subject: q.subject,
        topic,
        stem: q.stem.trim(),
        options: q.options.map((o) => String(o).trim()),
        answer,
        explanation: q.explanation || '',
        year,
        exam: String(q.exam || '').trim(),
        answerChecked: checked,
        origin: year || q.exam ? 'pyq' : q.origin || 'bank',
        sourceId,
        page: q.page > 0 ? q.page + pageOffset : null,
      });
      if (isNew) { summary.questions++; tally(q.subject, topic, 'questions'); } else summary.duplicates++;
    }
    for (const n of result.notes || []) {
      if (!SUBJECTS.includes(n.subject) || !n.content?.trim()) continue;
      const topic = topicFor(n.subject, n.topic);
      const isNew = await store.addNote({ subject: n.subject, topic, content: n.content.trim(), sourceId, page: n.page > 0 ? n.page + pageOffset : null });
      if (isNew) { summary.notes++; tally(n.subject, topic, 'notes'); } else summary.duplicates++;
    }
  };
}

const newSummary = () => ({ questions: 0, duplicates: 0, notes: 0, bySubject: {}, skipped: 0, errors: [], usedAi: false });

/**
 * Read an upload, split it into questions and notes, sort each into subject → topic and save.
 *
 * input: { buffer, mimeType, filename, caption, addedBy, onProgress? }
 * Returns a summary: { questions, duplicates, notes, bySubject: {subject: {topic: count}}, skipped, errors,
 *   paused?: { resumeAt } } — paused when the AI ran out of free quota; the job resumes by itself.
 */
export async function ingest({ buffer, mimeType, filename, caption = '', addedBy, onProgress = async () => {} }) {
  const hint = caption || filename || '';
  const kind =
    mimeType === 'application/pdf' ? 'pdf'
    : IMAGE_TYPES.includes(mimeType) ? 'image'
    : /^(audio|video)\//.test(mimeType) ? 'lecture'
    : mimeType === 'text/uri-list' ? 'link'
    : 'text';
  const sourceId = await store.addSource(filename || `${kind} upload`, kind, addedBy);
  const summary = newSummary();
  const save = makeSaver({ sourceId, summary, topics: await store.existingTopics() });
  const opts = async (extra = {}) => ({ hint, existingTopics: await store.existingTopics(), ...extra });

  // Lecture recordings and YouTube links: only Gemini can watch or listen.
  if (kind === 'lecture' || kind === 'link') {
    if (!mediaAvailable()) {
      summary.errors.push('Lectures and YouTube links need a Gemini key (GEMINI_API_KEY).');
      return summary;
    }
    summary.usedAi = true;
    const block =
      kind === 'link'
        ? { type: 'url', url: buffer.toString('utf8').trim() }
        : { type: 'media', source: { media_type: mimeType.split(';')[0], data: buffer.toString('base64') } };
    try {
      await save(await extract([block], { ...(await opts({ lecture: true })), hint: caption }));
    } catch (e) {
      summary.errors.push(friendlyError(e));
    }
    return summary;
  }

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
    for (const [i, chunk] of textChunks(text).entries()) {
      try {
        await save(await extract([textBlock(chunk)], await opts()));
      } catch (e) {
        // Out of AI quota: keep what the offline parser can read instead of losing the upload.
        if (e instanceof AiBusyError && parsed.questions.length) {
          await save({ questions: offlineQuestions(parsed.questions, { hintSubject }).questions });
          summary.errors.push('The AI is out of free quota for today, so I read the MCQs without it (no explanations, rougher topics).');
          break;
        }
        summary.errors.push(`Part ${i + 1}: ${friendlyError(e)}`);
      }
    }
    return summary;
  }

  summary.usedAi = true;
  if (kind === 'image') {
    try {
      await save(await extract([imageBlock(buffer, mimeType)], await opts()));
    } catch (e) {
      summary.errors.push(friendlyError(e));
    }
    return summary;
  }

  // PDFs run as a resumable job: survives restarts and pauses until the AI quota resets.
  let total;
  try {
    total = (await PDFDocument.load(buffer, { ignoreEncryption: true })).getPageCount();
  } catch (e) {
    summary.errors.push(`Couldn't open this PDF: ${e.message}`);
    return summary;
  }
  const chunk = await pagesPerPart(buffer, total);
  const parts = Math.ceil(total / chunk);
  const jobId = await store.createJob({ phone: addedBy, filename, caption, data: buffer, sourceId, parts, chunk });
  if (parts > 1) {
    await onProgress(`This PDF has ${total} pages. I'm reading it in ${parts} parts and saving questions as I go, so you can practise while it runs.`);
  }
  return runJob(jobId, { onProgress });
}

/** Question banks (lots of "A) … D)" options in the text layer) can go 10 pages per call; notes 4. */
async function pagesPerPart(buffer) {
  try {
    const pages = await pdfPages(buffer);
    const text = pages.join('\n');
    const options = (text.match(/(^|\n)\s*\(?[a-dA-D][).]\s+\S/g) || []).length;
    return options >= pages.length * 8 ? QBANK_PAGES : NOTE_PAGES;
  } catch {
    return NOTE_PAGES; // scanned: assume notes, the safer choice for coverage
  }
}

const friendlyError = (e) =>
  e instanceof AiBusyError ? 'The AI is out of free quota or busy right now.' : String(e.message || e).split('\n')[0].slice(0, 200);

const running = new Set();

/**
 * Read the remaining parts of a PDF upload job, job.chunk pages each (questions cut at a boundary are
 * skipped in one part and read whole in the next; duplicates
 * are dropped by hash). The first part runs alone so later parts reuse its topic names.
 */
export async function runJob(jobId, { onProgress = async () => {} } = {}) {
  if (running.has(jobId)) return null;
  running.add(jobId);
  try {
    const job = await store.getJob(jobId);
    const buffer = Buffer.from(job.data);
    const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const total = src.getPageCount();
    const summary = { ...newSummary(), ...job.summary, errors: [], paused: undefined };
    const done = new Set(job.done_parts || []);
    let pages = [];
    try { pages = await pdfPages(buffer); } catch { /* scanned or odd PDF: the AI reads it anyway */ }
    const keyMap = parseAnswerKey(pages.join('\n'));
    const answerKey = Object.entries(keyMap).slice(0, 600).map(([n, i]) => `${n}-${'abcd'[i]}`).join(', ');
    const save = makeSaver({ sourceId: job.source_id, summary, topics: await store.existingTopics(), answerKey: keyMap });
    const hint = job.caption || job.filename || '';
    await store.updateJob(jobId, { status: 'running' });

    let busy = null;
    const size = job.chunk || 20;
    let nextMark = Math.floor((done.size / job.parts) * 4 + 1) / 4;
    const readPart = async (part) => {
      const from = part * size + 1;
      // Question banks overlap by a page so a question cut at the boundary is read whole next time (exact
      // duplicates are dropped by hash). Notes don't: the AI rewords them, so overlap would duplicate.
      const to = Math.min(total, from + size - 1 + (size >= QBANK_PAGES ? 1 : 0));
      try {
        for (const r of await extractRange(src, from, to, { hint, answerKey, pages })) await save(r.result, r.offset);
        done.add(part);
      } catch (e) {
        if (e instanceof AiBusyError) { busy = e; return; }
        summary.errors.push(`Pages ${from}-${to}: ${friendlyError(e)}`);
        done.add(part);
      }
      console.log(`${job.filename}: part ${done.size}/${job.parts} read, ${summary.questions} questions and ${summary.notes} notes so far`);
      await store.updateJob(jobId, { done_parts: [...done], summary: { ...summary, errors: [] } });
      if (job.parts > 1 && done.size < job.parts && done.size / job.parts >= nextMark) {
        while (done.size / job.parts >= nextMark) nextMark += 0.25;
        await onProgress(`⏳ ${Math.round((100 * done.size) / job.parts)}% read: ${summary.questions} questions and ${summary.notes} note sections saved so far.`);
      }
    };

    const todo = Array.from({ length: job.parts }, (_, i) => i).filter((i) => !done.has(i));
    if (todo.length && !done.size) await readPart(todo.shift());
    const inFlight = new Set();
    for (const part of todo) {
      if (busy) break;
      const p = readPart(part).finally(() => inFlight.delete(p));
      inFlight.add(p);
      if (inFlight.size >= PARALLEL_PARTS) await Promise.race(inFlight);
    }
    await Promise.all(inFlight);

    if (busy && done.size < job.parts) {
      const resumeAt = new Date(busy.resetAt || Date.now() + 60 * 60e3);
      await store.updateJob(jobId, { status: 'paused', resume_at: resumeAt.toISOString(), done_parts: [...done], summary: { ...summary, errors: [] } });
      return { ...summary, paused: { resumeAt, partsDone: done.size, parts: job.parts } };
    }
    await store.updateJob(jobId, { status: 'done', data: null, summary: { ...summary, errors: [] } });
    return summary;
  } finally {
    running.delete(jobId);
  }
}

/** Extract pages from..to; if the answer is cut off (too much output), split the range and try both halves. */
async function extractRange(src, from, to, { hint, answerKey, pages = [] }) {
  try {
    const fallbackText = pages.slice(from - 1, to).map((p, i) => `--- Page ${from + i} ---\n${p}`).join('\n');
    const result = await extract([pdfBlock(await subPdf(src, from, to))], { hint, answerKey, fallbackText, existingTopics: await store.existingTopics() });
    return [{ result, offset: from - 1 }];
  } catch (e) {
    if (e.code !== 'MAX_TOKENS' || to <= from) throw e;
    const mid = Math.floor((from + to) / 2);
    return [...(await extractRange(src, from, mid, { hint, answerKey, pages })), ...(await extractRange(src, mid + 1, to, { hint, answerKey, pages }))];
  }
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

/** "at 5:30 PM" today, or "tomorrow at 5:30 PM", in the bot's timezone. */
export function whenText(at, now = new Date()) {
  const d = new Date(at);
  const day = (x) => x.toLocaleDateString('en-CA', { timeZone: config.timezone });
  const time = d.toLocaleTimeString('en-US', { timeZone: config.timezone, hour: 'numeric', minute: '2-digit' });
  if (d - now < 60 * 60e3) return 'within the hour';
  if (day(d) === day(now)) return `at ${time}`;
  if (day(d) === day(new Date(now.getTime() + 24 * 3600e3))) return `tomorrow at ${time}`;
  return `on ${d.toLocaleDateString('en-GB', { timeZone: config.timezone, day: 'numeric', month: 'short' })} at ${time}`;
}

export function formatSummary(summary, filename) {
  const lines = [];
  const name = filename ? `*${filename}*` : 'your upload';
  if (!summary.questions && !summary.notes && summary.paused) {
    lines.push(`Nothing saved from ${name} yet.`);
  } else if (!summary.questions && !summary.notes) {
    lines.push(summary.duplicates ? `Everything in ${name} is already in your bank.` : `I couldn't add anything from ${name}.`);
  } else {
    const parts = [];
    if (summary.questions) parts.push(`${summary.questions} questions`);
    if (summary.notes) parts.push(`${summary.notes} note sections`);
    lines.push(`✅ *Upload complete*`, `_${filename || 'Your upload'}_`, '');
    if (summary.questions) lines.push(`📝 *Questions:* ${summary.questions}`);
    if (summary.notes) lines.push(`📖 *Note sections:* ${summary.notes}`);
    lines.push('', '🗂 *Filed under*');
    for (const [subject, topics] of Object.entries(summary.bySubject)) {
      lines.push('', `📘 *${subject}*`);
      for (const [topic, c] of Object.entries(topics)) {
        const bits = [];
        if (c.questions) bits.push(`${c.questions} Q`);
        if (c.notes) bits.push(`${c.notes} notes`);
        lines.push(`• ${topic}: ${bits.join(', ')}`);
      }
    }
  }
  if (summary.paused) {
    const { partsDone, parts, resumeAt } = summary.paused;
    lines.push('', `⏸ *Paused* at part ${partsDone} of ${parts}. The free AI quota ran out, so I'll carry on by myself ${whenText(resumeAt)} and message you when it's done. Nothing to resend.`);
  }
  if (summary.duplicates) lines.push('', `${summary.duplicates} were already in your bank, skipped.`);
  if (summary.skipped) lines.push(`${summary.skipped} couldn't be read as complete 4-option questions.`);
  for (const e of summary.errors) lines.push(`⚠️ ${e}`);
  return lines.join('\n');
}
