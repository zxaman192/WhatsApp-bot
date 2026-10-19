import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { SUBJECTS } from '../subjects.js';

let client;
const getClient = () => (client ??= new Anthropic({ apiKey: config.anthropic.apiKey }));

export const claudeAvailable = () => Boolean(config.anthropic.apiKey);

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'questions', 'notes'],
  properties: {
    kind: { type: 'string', enum: ['question_bank', 'pyq', 'notes', 'mixed', 'unrelated'] },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'topic', 'stem', 'options', 'answer_index', 'explanation', 'year', 'exam', 'answer_given_in_source', 'origin', 'page'],
        properties: {
          subject: { type: 'string', enum: SUBJECTS },
          topic: { type: 'string' },
          stem: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          answer_index: { type: 'integer' },
          explanation: { type: 'string' },
          year: { type: 'string' },
          exam: { type: 'string' },
          answer_given_in_source: { type: 'boolean' },
          origin: { type: 'string', enum: ['bank', 'pyq', 'notes'] },
          page: { type: 'integer' },
        },
      },
    },
    notes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'topic', 'content', 'page'],
        properties: {
          subject: { type: 'string', enum: SUBJECTS },
          topic: { type: 'string' },
          content: { type: 'string' },
          page: { type: 'integer' },
        },
      },
    },
  },
};

const SYSTEM = `You help a doctor prepare for the NEET PG exam. You receive one chunk of material they uploaded: a question bank, previous year questions (PYQs), or study notes, possibly a photo or scanned page.

Turn it into database records:

1. Questions. If the material contains MCQs, extract every one of them faithfully (fix obvious OCR errors only). Each must have exactly 4 options. If the source gives the answer, use it and set answer_given_in_source=true. If it does not, work out the correct answer yourself, set answer_given_in_source=false, and say why in the explanation. Write a short, high-yield explanation (2-4 sentences) when the source has none. Set origin="pyq" and fill year/exam (e.g. "2021", "NEET PG", "INI-CET", "AIIMS") when the question is marked as a previous year question; otherwise origin="bank" and leave year/exam empty unless shown.

2. Notes. If the material is study notes, split it into sections, one per topic, and store each as a note: a faithful, compact version of the content (keep numbers, drug names, classifications, mnemonics; drop filler). Then write 3-6 exam-style single-best-answer MCQs per topic from those notes, testing the most examinable facts, with origin="notes" and answer_given_in_source=false.

3. Sorting. File every question and note under exactly one of the subjects in the schema, and a topic that is a standard chapter-level heading for that subject (for example Pharmacology → "Autonomic Nervous System", Pathology → "Neoplasia", Community Medicine → "Epidemiology"). Reuse an existing topic name from the list given to you whenever one fits, so the same chapter is not split into near-duplicates. Use title case.

4. Page. For PDFs, set page to the page number within this chunk (1 = first page you were given) where the question or note section starts; use 0 for images and plain text.

Do not invent questions from material that is not medical; set kind="unrelated" and return empty arrays. Do not number the stem or options (no "1." or "a)").`;

/**
 * Send one chunk to Claude. `content` is an array of Anthropic content blocks
 * (a document, image or text block). Returns the parsed JSON object.
 */
export async function extractWithClaude(contentBlocks, { hint = '', existingTopics = {} } = {}) {
  const topicList = Object.entries(existingTopics)
    .map(([s, topics]) => `${s}: ${topics.join(', ')}`)
    .join('\n');
  const instructions = [
    hint && `The user's caption for this upload: "${hint}". If it names a subject, prefer that subject when it fits.`,
    topicList ? `Topics already in the database:\n${topicList}` : 'The database is empty so far.',
    'Extract everything in this chunk.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const stream = getClient().beta.messages.stream({
    model: config.anthropic.model,
    max_tokens: 64000,
    system: SYSTEM,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: [...contentBlocks, { type: 'text', text: instructions }] }],
  });
  const msg = await stream.finalMessage();

  if (msg.stop_reason === 'refusal') throw new Error('Claude declined to process this file.');
  if (msg.stop_reason === 'max_tokens') throw new Error('This part of the file was too long to process in one go.');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

export const pdfBlock = (buffer) => ({
  type: 'document',
  source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
});

export const imageBlock = (buffer, mediaType) => ({
  type: 'image',
  source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') },
});

export const textBlock = (text) => ({ type: 'text', text });

const EXPLAIN_SYSTEM = `You are a NEET PG study assistant on WhatsApp. Answer the doctor's question using their own notes, which are given to you as numbered excerpts. Base the answer on the excerpts and cite them inline like [1] or [2]. If the excerpts don't cover something important, you may add it from standard textbooks but mark that sentence with (not in your notes). Keep it compact and exam-focused: key facts, numbers, drugs of choice, classifications, a mnemonic if one helps. Use WhatsApp formatting only: *bold*, _italic_, and simple "- " bullets. No headings, no tables, no markdown links. Stay under 1200 characters.`;

/** Explain a topic or question from the user's notes. excerpts: [{label, text}] */
export async function explainFromNotes(question, excerpts) {
  const context = excerpts.map((e, i) => `[${i + 1}] (${e.label})\n${e.text}`).join('\n\n');
  const stream = getClient().beta.messages.stream({
    model: config.anthropic.model,
    max_tokens: 4000,
    system: EXPLAIN_SYSTEM,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    messages: [
      {
        role: 'user',
        content: `My notes:\n\n${context || '(no matching notes found)'}\n\nMy question: ${question}`,
      },
    ],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined to answer this.');
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}
