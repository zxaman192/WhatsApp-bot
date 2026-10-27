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
    out[k] = k === 'type' ? String(v).toUpperCase() : k === 'enum' ? v : k === 'properties' ? toGeminiProps(v) : toGeminiSchema(v);
  }
  // Without this Gemini writes properties alphabetically (answer_index before the stem).
  if (s.properties) out.propertyOrdering = Object.keys(s.properties);
  return out;
}
function toGeminiProps(props) {
  return Object.fromEntries(Object.entries(props).map(([name, def]) => [name, toGeminiSchema(def)]));
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

/** Thrown when every Gemini model is out of free quota or overloaded. resetAt: when the first one frees up. */
export class AiBusyError extends Error {
  constructor(message, resetAt = null) {
    super(message);
    this.name = 'AiBusyError';
    this.resetAt = resetAt;
  }
}

// Each model has its own free-tier quota, so when one runs out (or is overloaded) we move to the next.
// model -> time (ms) until which we skip it.
const resting = new Map();

export function modelChain() {
  return [...new Set([config.gemini.model, ...config.gemini.fallbackModels])].filter(Boolean);
}

/** "Please retry in 20h46m31.1s" or RetryInfo "41s" → milliseconds. */
export function retryDelayMs(data) {
  const info = data.error?.details?.find((d) => String(d['@type'] || '').includes('RetryInfo'))?.retryDelay;
  const text = info || (data.error?.message || '').match(/retry in ([\dhms.]+)/i)?.[1] || '';
  let ms = 0;
  for (const [, n, unit] of text.matchAll(/([\d.]+)([hms])/g)) ms += Number(n) * { h: 3600e3, m: 60e3, s: 1e3 }[unit];
  return ms || 60e3;
}

// Gemini 3 models think before answering; "low" keeps reading uploads fast without hurting extraction.
const thinkingFor = (model) => (/^gemini-3/.test(model) ? { thinkingConfig: { thinkingLevel: 'low' } } : {});

async function callModel(model, { system, parts, json, maxTokens, schema, timeoutMs, mediaLow, thinking = true }) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    signal: AbortSignal.timeout(timeoutMs),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        ...(thinking ? thinkingFor(model) : {}),
        // Lecture videos: slides stay legible at low resolution and it cuts the tokens a lot.
        ...(mediaLow ? { mediaResolution: 'MEDIA_RESOLUTION_LOW' } : {}),
        ...(json ? { responseMimeType: 'application/json', responseSchema: schema } : {}),
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

export async function generate({ system, parts, json, maxTokens, schema = GEMINI_SCHEMA, timeoutMs = 4 * 60 * 1000, mediaLow = false }) {
  const now = Date.now();
  const models = modelChain();
  const available = models.filter((m) => (resting.get(m) || 0) <= now);
  let lastError = null;
  for (const model of available) {
    let res, data;
    try {
      ({ res, data } = await callModel(model, { system, parts, json, maxTokens, schema, timeoutMs, mediaLow }));
      // A model that doesn't take the thinking setting: ask again without it.
      if (res.status === 400 && /thinking/i.test(data.error?.message || '')) {
        ({ res, data } = await callModel(model, { system, parts, json, maxTokens, schema, timeoutMs, mediaLow, thinking: false }));
      }
    } catch (e) {
      lastError = new Error(`${model} timed out`);
      console.warn(`Gemini ${model}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}, trying the next model`);
      continue;
    }
    if ([429, 500, 503, 404].includes(res.status)) {
      // Out of quota: rest it until the quota resets. Busy or retired: rest it briefly.
      const rest = res.status === 429 ? retryDelayMs(data) : res.status === 404 ? 24 * 3600e3 : 2 * 60e3;
      resting.set(model, Date.now() + rest);
      console.warn(`Gemini ${model}: ${res.status} ${String(data.error?.message || '').split('\n')[0].slice(0, 120)}; resting it ${Math.round(rest / 60e3)} min`);
      lastError = new AiBusyError(data.error?.message || `Gemini ${res.status}`);
      continue;
    }
    if (!res.ok) throw new Error(`Gemini error (${res.status}): ${data.error?.message || 'unknown'}`);
    const cand = data.candidates?.[0];
    if (!cand) throw new Error(`Gemini returned nothing${data.promptFeedback?.blockReason ? ` (${data.promptFeedback.blockReason})` : ''}.`);
    if (cand.finishReason === 'MAX_TOKENS') {
      const err = new Error('This part of the file was too long to process in one go.');
      err.code = 'MAX_TOKENS';
      throw err;
    }
    if (cand.finishReason && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(cand.finishReason)) {
      throw new Error(`Gemini stopped early (${cand.finishReason}).`);
    }
    return (cand.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  }
  const resetAt = Math.min(...models.map((m) => resting.get(m) || Infinity));
  if (lastError instanceof AiBusyError || !available.length) {
    throw new AiBusyError('All Gemini models are out of free quota or busy right now.', Number.isFinite(resetAt) ? resetAt : null);
  }
  throw lastError || new AiBusyError('No Gemini model is available.');
}

/** For tests. */
export const resetResting = () => resting.clear();

export { toParts };

export async function extractWithGemini(contentBlocks, { hint = '', existingTopics = {}, ...extra } = {}) {
  const text = await generate({
    system: SYSTEM,
    parts: [...toParts(contentBlocks), { text: extractInstructions(hint, existingTopics, extra) }],
    json: true,
    maxTokens: 65536,
    mediaLow: Boolean(extra.lecture),
  });
  try {
    return JSON.parse(text);
  } catch {
    // Usually a cut-off answer; the caller splits the chunk and tries again.
    throw Object.assign(new Error('The AI returned an unreadable answer for this part.'), { code: 'MAX_TOKENS' });
  }
}

export async function explainWithGemini(question, excerpts, { system = EXPLAIN_SYSTEM } = {}) {
  const context = notesContext(excerpts);
  const text = await generate({
    system,
    parts: [{ text: `My notes:\n\n${context || '(no matching notes found)'}\n\nMy question: ${question}` }],
    json: false,
    maxTokens: 4000,
    timeoutMs: 60 * 1000,
  });
  return text.trim();
}
