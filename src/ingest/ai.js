// Picks the AI provider: AI_PROVIDER if set, otherwise whichever key is present (Gemini first, as it has a free tier).
import { config } from '../config.js';
import { claudeAvailable, extractWithClaude, explainFromNotes, claudeJson, WHY_SYSTEM, whyPrompt } from './claude.js';
import { geminiAvailable, extractWithGemini, explainWithGemini, generate, toGeminiSchema, toParts, AiBusyError } from './gemini.js';

import { groqAvailable, extractWithGroq, explainWithGroq, transcribeWithGroq, chat as groqChat } from './groq.js';

export { AiBusyError };

/** Run `primary`; if it is out of quota and a Groq key is set, run `backup` instead. */
async function withBackup(primary, backup) {
  try {
    return await primary();
  } catch (e) {
    if (!(e instanceof AiBusyError) || !groqAvailable() || !backup) throw e;
    console.warn(`Gemini busy (${e.message.slice(0, 80)}); using Llama on Groq`);
    return backup();
  }
}

export function provider() {
  const want = config.aiProvider;
  if (want === 'claude') return claudeAvailable() ? 'claude' : null;
  if (want === 'gemini') return geminiAvailable() ? 'gemini' : null;
  if (want === 'none') return null;
  return geminiAvailable() ? 'gemini' : claudeAvailable() ? 'claude' : null;
}

export const aiAvailable = () => provider() !== null;

/**
 * opts.fallbackText: the text layer of a PDF part, so the text-only backup can still read it.
 */
export const extract = (blocks, { fallbackText = '', ...opts } = {}) => {
  if (provider() !== 'gemini') return extractWithClaude(blocks, opts);
  const text = blocks.every((b) => b.type === 'text') ? blocks.map((b) => b.text).join('\n') : fallbackText;
  return withBackup(
    () => extractWithGemini(blocks, opts),
    text && text.trim().length >= 200 ? () => extractWithGroq(text, opts) : null
  );
};

export const explain = async (question, excerpts, opts) =>
  tidy(
    await (provider() === 'gemini'
      ? withBackup(() => explainWithGemini(question, excerpts, opts), () => explainWithGroq(question, excerpts, opts))
      : explainFromNotes(question, excerpts, opts))
  );

/** Models slip into Markdown; turn it into chat formatting (*bold*, • bullets) and drop stray blank lines. */
export function tidy(text) {
  return String(text)
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/^#{1,6}\s*(.+)$/gm, '*$1*')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Why the keyed answer of a question is right and the others wrong, citing the notes. */
export const explainQuestion = (q, excerpts) => explain(whyPrompt(q), excerpts, { system: WHY_SYSTEM });

/** Audio, video and YouTube links can only be read by Gemini. */
export const mediaAvailable = () => provider() === 'gemini';

/** Speech to text (Gemini). */
export async function transcribe(buffer, mimeType) {
  return withBackup(() => transcribeWithGemini(buffer, mimeType), () => transcribeWithGroq(buffer, mimeType.split(';')[0]));
}

async function transcribeWithGemini(buffer, mimeType) {
  const text = await generate({
    system:
      'Transcribe the voice message. Write medical terms, drug and disease names in standard English spelling (Latin script), even if the rest is Hindi or Hinglish. Output only the transcript, nothing else.',
    parts: toParts([{ type: 'audio', source: { media_type: mimeType.split(';')[0], data: buffer.toString('base64') } }]),
    json: false,
    maxTokens: 2000,
    timeoutMs: 60 * 1000,
  });
  return text.trim();
}

const FLASH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cards'],
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['front', 'back'],
        properties: { front: { type: 'string' }, back: { type: 'string' } },
      },
    },
  },
};
const FLASH_SYSTEM =
  'Make 5 NEET PG flashcards from the notes you are given, on the most examinable facts (drugs of choice, numbers, classic signs, classifications). Each front is a short question or a sentence with a blank written as [...]; each back is the answer in a few words, plus a mnemonic if a well-known one exists. Use only facts from the notes. Plain text, no markdown.';

export async function flashcards(noteText) {
  const content = `Notes:\n${noteText.slice(0, 6000)}`;
  const out =
    provider() === 'gemini'
      ? JSON.parse(
          await withBackup(
            () => generate({ system: FLASH_SYSTEM, parts: [{ text: content }], json: true, maxTokens: 4000, schema: toGeminiSchema(FLASH_SCHEMA), timeoutMs: 60 * 1000 }),
            () => groqChat({ system: `${FLASH_SYSTEM} Reply with JSON: {"cards": [{"front": "...", "back": "..."}]}`, user: content, json: true, maxTokens: 2000 })
          )
        )
      : await claudeJson(FLASH_SYSTEM, content, FLASH_SCHEMA, 2000);
  return (out.cards || []).filter((c) => c.front && c.back).slice(0, 5);
}
