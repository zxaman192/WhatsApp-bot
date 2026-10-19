// Google Gemini as an alternative to Claude (free API key from aistudio.google.com).
// Same prompts and output shape as claude.js, so the rest of the bot doesn't care which one runs.
import { config } from '../config.js';
import { SCHEMA, SYSTEM, EXPLAIN_SYSTEM, extractInstructions, notesContext } from './claude.js';

export const geminiAvailable = () => Boolean(config.gemini.apiKey);

// Gemini's responseSchema is an OpenAPI subset: upper-case types, no additionalProperties.
export function toGeminiSchema(s) {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'additionalProperties') continue;
    out[k] = k === 'type' ? String(v).toUpperCase() : k === 'enum' ? v : toGeminiSchema(v);
  }
  return out;
}
const GEMINI_SCHEMA = toGeminiSchema(SCHEMA);

// Convert our Anthropic-style content blocks into Gemini parts.
function toParts(blocks) {
  return blocks.map((b) => {
    if (b.type === 'text') return { text: b.text };
    if (b.type === 'url') return { file_data: { file_uri: b.url } };
    return { inline_data: { mime_type: b.source.media_type, data: b.source.data } };
  });
}

export async function generate({ system, parts, json, maxTokens, schema = GEMINI_SCHEMA }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        ...(json ? { responseMimeType: 'application/json', responseSchema: schema } : {}),
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini error (${res.status}): ${data.error?.message || 'unknown'}`);
  const cand = data.candidates?.[0];
  if (!cand) throw new Error(`Gemini returned nothing${data.promptFeedback?.blockReason ? ` (${data.promptFeedback.blockReason})` : ''}.`);
  if (cand.finishReason === 'MAX_TOKENS') throw new Error('This part of the file was too long to process in one go.');
  if (cand.finishReason && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(cand.finishReason)) {
    throw new Error(`Gemini stopped early (${cand.finishReason}).`);
  }
  return (cand.content?.parts || []).map((p) => p.text || '').join('');
}

export { toParts };

export async function extractWithGemini(contentBlocks, { hint = '', existingTopics = {} } = {}) {
  const text = await generate({
    system: SYSTEM,
    parts: [...toParts(contentBlocks), { text: extractInstructions(hint, existingTopics) }],
    json: true,
    maxTokens: 65536,
  });
  return JSON.parse(text);
}

export async function explainWithGemini(question, excerpts) {
  const context = notesContext(excerpts);
  const text = await generate({
    system: EXPLAIN_SYSTEM,
    parts: [{ text: `My notes:\n\n${context || '(no matching notes found)'}\n\nMy question: ${question}` }],
    json: false,
    maxTokens: 4000,
  });
  return text.trim();
}
