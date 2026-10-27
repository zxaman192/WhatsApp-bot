import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { SUBJECTS } from '../subjects.js';

let client;
// Server-side refusal fallback exists for the Opus, Sonnet and Fable families, not Haiku.
const fallbackParams = () =>
  /haiku/.test(config.anthropic.model) ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
const getClient = () => (client ??= new Anthropic({ apiKey: config.anthropic.apiKey }));

export const claudeAvailable = () => Boolean(config.anthropic.apiKey);

// Property order matters: the model writes fields in this order, so notes come before the MCQs made from them,
// and each question's stem, options and explanation come before it commits to an answer.
export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'notes', 'questions'],
  properties: {
    kind: { type: 'string', enum: ['question_bank', 'pyq', 'notes', 'mixed', 'unrelated'] },
    notes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'topic', 'page', 'content'],
        properties: {
          subject: { type: 'string', enum: SUBJECTS },
          topic: { type: 'string' },
          page: { type: 'integer' },
          content: { type: 'string' },
        },
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'subject', 'topic', 'page', 'year', 'exam', 'origin', 'stem', 'options', 'answer_given_in_source', 'explanation', 'answer_index'],
        properties: {
          number: { type: 'string', description: 'The question number as printed, e.g. "12"; empty if none.' },
          subject: { type: 'string', enum: SUBJECTS },
          topic: { type: 'string' },
          page: { type: 'integer' },
          year: { type: 'string' },
          exam: { type: 'string', description: 'One of NEET PG, INI-CET, AIIMS, PGI, JIPMER, FMGE, DNB, UPSC CMS, Other; empty if not a PYQ.' },
          origin: { type: 'string', enum: ['bank', 'pyq', 'notes'] },
          stem: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          answer_given_in_source: { type: 'boolean' },
          explanation: { type: 'string' },
          answer_index: { type: 'integer', description: '0-based: A = 0, B = 1, C = 2, D = 3.' },
        },
      },
    },
  },
};

export const SYSTEM = `You help a doctor prepare for the NEET PG exam. You receive one chunk of material they uploaded: a question bank, previous year questions (PYQs), or study notes, possibly a photo or scanned page.

Turn it into database records:

1. Questions. Extract every single-best-answer MCQ faithfully (fix obvious OCR errors only; do not number the stem or options, no "1." or "a)").
- Keep only questions with exactly 4 options as printed. Skip, do not adapt, questions with 5 options, multiple-correct (PGI style), match-the-following that can't be written as 4 options, and questions that depend on an image, ECG or X-ray you can't reproduce in text, unless the stem fully describes it.
- If a question at the very start or end of this chunk is cut off (stem without options, or options without stem), skip it. Never complete missing text.
- answer_index is 0-based: A or the 1st option = 0, B = 1, C = 2, D = 3.
- If the source gives the answer (inline, in a solution, or in an answer key you are given), use it and set answer_given_in_source=true. Coaching keys are sometimes wrong: keep the source's answer, but if it clearly contradicts current standard references (Harrison, Robbins, KDT, Park, Williams, Bailey & Love, Ghai, current national programme guidelines), start the explanation with "Disputed key:" and give the correct answer and why.
- If the source gives no answer, work it out, set answer_given_in_source=false, and prefer the answer accepted in recent NEET PG / INI-CET keys. If two options are defensible, say so.
- explanation: 2-4 sentences, high-yield: why the answer is right, and the key fact that rules out the closest wrong option. Never invent numbers (doses, cut-offs, percentages) that are not in the source or standard references.
- PYQs: a year or exam may be in a section heading that applies to every question below it, or in brackets after the stem ("(AIIMS May 2018)", "[NEET PG 21]", "PGI Dec 09"). Put the 4-digit year in year ("09" means "2009"), the exam in exam, set origin="pyq", and remove the tag from the stem. Otherwise origin="bank" and leave year and exam empty.

2. Notes. If the material is study notes (coaching notes, a textbook, slides, handwritten pages), coverage is the priority: the doctor wants every fact from every page in the database, not a summary.
- Go page by page and keep everything examinable: every heading, bullet, table row, box, flowchart, diagram label, "most common", number, eponym, sign, classification and mnemonic. Do not merge pages, do not shorten lists, do not drop "minor" facts.
- One note per sub-heading or box (a dense page usually gives 8 to 20 notes). Format each note's content as a bold title line, then one fact per line:
  "*Laryngomalacia*\n• Most common congenital anomaly of the larynx\n• Inspiratory stridor, better on feeding and prone\n• Omega-shaped epiglottis\n• Rx: wait and watch; supraglottoplasty if severe"
  Keep the source's own wording, numbers and abbreviations. Tables: one line per row ("• Type A: normal").
- Then MCQs from the notes: at least 5 per page of notes and up to 10 on dense pages, each testing a different fact (one question per "most common", number, sign, drug of choice, eponym, investigation of choice or treatment). Vary the format: one-liners, clinical vignettes, "all except". Distractors come from the same category (four nerves, four signs, four drugs). origin="notes", answer_given_in_source=false. Explanation: 1-2 sentences quoting the fact from the notes.

3. Sorting. File every question and note under exactly one of the subjects in the schema, and a topic that is a standard chapter-level heading for what that page is actually about (e.g. ENT → "Larynx", "Nose and Paranasal Sinuses", "Epistaxis", "Middle Ear", "Inner Ear", "Facial Nerve", "Pharynx"; Pharmacology → "Autonomic Nervous System"). Reuse an existing topic name from the list only when it is the same chapter; never file a page under a different chapter just because that name exists (nose content is never "External Ear"). Use title case; never "General" if a real chapter fits.

4. Page. For PDFs, set page to the page number within this chunk (1 = first page you were given) where the question or note starts; use 0 for images and plain text. For recordings, set page to the minute where it is discussed.

If the material is not medical, set kind="unrelated" and return empty arrays.`;

export function extractInstructions(hint, existingTopics, { answerKey = '', lecture = false } = {}) {
  const topicList = Object.entries(existingTopics)
    .map(([s, topics]) => `${s}: ${topics.filter((t) => t !== 'General').join(', ')}`)
    .filter((l) => !l.endsWith(': '))
    .join('\n');
  return [
    lecture && 'This is a recorded lecture, not a document. Treat it as study notes: write the key teaching points as notes per topic, then MCQs from them.',
    hint && `The user's caption for this upload: "${hint}". If it names a subject, prefer that subject when it fits.`,
    answerKey && `Answer key found elsewhere in this file (question number → answer): ${answerKey}`,
    topicList ? `Topics already in the database:\n${topicList}` : 'The database is empty so far.',
    'Extract everything in this chunk: every question, and for notes every fact on every page (see the coverage rules).',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const notesContext = (excerpts) => excerpts.map((e, i) => `[${i + 1}] (${e.label})\n${e.text}`).join('\n\n');

/**
 * Send one chunk to Claude. `content` is an array of Anthropic content blocks
 * (a document, image or text block). Returns the parsed JSON object.
 */
export async function extractWithClaude(contentBlocks, { hint = '', existingTopics = {}, ...extra } = {}) {
  const instructions = extractInstructions(hint, existingTopics, extra);

  const stream = getClient().beta.messages.stream({
    model: config.anthropic.model,
    max_tokens: 64000,
    system: SYSTEM,
    ...fallbackParams(),
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: [...contentBlocks, { type: 'text', text: instructions }] }],
  });
  const msg = await stream.finalMessage();

  if (msg.stop_reason === 'refusal') throw new Error('The AI declined to process this file.');
  if (msg.stop_reason === 'max_tokens') throw Object.assign(new Error('This part of the file was too long to process in one go.'), { code: 'MAX_TOKENS' });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('The AI returned an unreadable answer for this part.'), { code: 'MAX_TOKENS' });
  }
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

export const EXPLAIN_SYSTEM = `You are a NEET PG study assistant in a chat app. Answer the doctor's question using their own notes, given to you as numbered excerpts (some may be question-bank items with a keyed answer).
Content:
- Cite [n] only for facts actually stated in excerpt n. If the excerpts are off-topic, ignore them, say "Your notes don't cover this," then answer from standard textbooks (Harrison, Robbins, KDT, Park, Williams, Bailey & Love, Ghai) and add _(not in your notes)_ after those facts.
- Flag anything in the notes that is outdated against current guidelines (changed drug of choice, programme targets) with ⚠️.
- Exam-focused and compact: key facts, numbers, drugs of choice, classifications.
Layout (a chat reply formatted like a polished ChatGPT answer; WhatsApp-style formatting, single asterisks):
💡 *<the direct answer in one bold line>*
<one or two plain sentences that explain it>

📌 *Key points*
• <a fact with the *key term* in bold>
• <3 to 6 such bullets in total>

<Only when they help, add one or two more sections, each an emoji, a bold header and bullets or numbered steps (1. 2. 3.):
🧬 *Mechanism*, 🩺 *Clinical features*, 🧪 *Diagnosis*, 💊 *Treatment*, 📊 *Classification*, ⚖️ *Comparison*>

🧠 *Mnemonic:* <only if a well-known one exists; otherwise leave this line out>
🎯 *Exam tip:* <the one fact most likely to be asked>
Rules: one blank line between sections; *bold* and _italic_ only; never **double asterisks**, # headings, tables or links. Under 1800 characters.`;

export const WHY_SYSTEM = `You are a NEET PG tutor. Explain one MCQ to the doctor who just answered it.
Content:
- If standard references (Harrison, Robbins, KDT, Park, Williams, Bailey & Love, Ghai, current guidelines) contradict the keyed answer, start with a line "⚠️ *Key may be wrong:* <correct answer and why>".
- Cite the doctor's notes as [n] only for facts stated in excerpt n; add _(not in your notes)_ after textbook facts.
Layout (a chat reply formatted like a polished ChatGPT answer; WhatsApp-style formatting, single asterisks):
✅ *Answer: <letter>. <keyed answer>*
<one or two lines on why it is right, with the *key term* in bold>

❌ *Why not the others*
• *<letter>. <option>*: <the key fact that rules it out, one line>
(one bullet for each wrong option)

🎯 *Exam tip:* <one related high-yield fact or mnemonic>
Rules: one blank line between sections; *bold* and _italic_ only; never **double asterisks**, # headings or tables. Under 1300 characters.`;

/** The user message for a "why" request. */
export function whyPrompt(q, letters = ['A', 'B', 'C', 'D']) {
  return [
    `Question: ${q.stem}`,
    `Options: ${q.options.map((o, i) => `${letters[i]}) ${o}`).join('  ')}`,
    `Keyed answer: ${letters[q.answer]}) ${q.options[q.answer]} (${q.answer_checked ? 'from the source key' : 'worked out by AI, unverified'})`,
    q.explanation ? `Stored explanation: ${q.explanation}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Explain a topic or question from the user's notes. excerpts: [{label, text}] */
export async function explainFromNotes(question, excerpts, { system = EXPLAIN_SYSTEM } = {}) {
  const context = notesContext(excerpts);
  const stream = getClient().beta.messages.stream({
    model: config.anthropic.model,
    max_tokens: 4000,
    system,
    ...fallbackParams(),
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

/** Generic structured-output call: returns parsed JSON matching `schema`. */
export async function claudeJson(system, content, schema, maxTokens = 8000) {
  const stream = getClient().beta.messages.stream({
    model: config.anthropic.model,
    max_tokens: maxTokens,
    system,
    ...fallbackParams(),
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('The AI declined this request.');
  if (msg.stop_reason === 'max_tokens') throw new Error('The answer was too long.');
  return JSON.parse(msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
}
