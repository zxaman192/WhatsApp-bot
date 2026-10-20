// Llama on Groq (free key from console.groq.com): the backup when every Gemini model is out of free quota.
// Text only, so PDFs fall back to their selectable text; voice notes use Groq's Whisper.
import { config } from '../config.js';
import { AiBusyError } from './gemini.js';
import { SCHEMA, SYSTEM, extractInstructions, notesContext, EXPLAIN_SYSTEM } from './claude.js';

export const groqAvailable = () => Boolean(config.groq.apiKey);

const BASE = 'https://api.groq.com/openai/v1';
let restingUntil = 0;
// Groq retires models from time to time; if the configured one is gone, try these Llama models in turn.
const MODELS = () => [...new Set([config.groq.model, 'llama-3.3-70b-versatile', 'meta-llama/llama-4-maverick-17b-128e-instruct', 'meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.1-8b-instant'])];
const retired = new Set();

function busy(res, data) {
  const after = Number(res.headers.get('retry-after')) || 60;
  restingUntil = Date.now() + after * 1000;
  return new AiBusyError(`Groq is busy: ${data.error?.message || res.status}`, restingUntil);
}

export async function chat(opts) {
  if (Date.now() < restingUntil) throw new AiBusyError('Groq is resting after a rate limit.', restingUntil);
  for (const model of MODELS().filter((m) => !retired.has(m))) {
    const out = await chatWith(model, opts);
    if (out !== RETIRED) return out;
    console.warn(`Groq model ${model} is not available; trying the next one`);
    retired.add(model);
  }
  throw new Error('No Groq Llama model is available. Set GROQ_MODEL to a current model.');
}

const RETIRED = Symbol('retired');

async function chatWith(model, { system, user, json = false, maxTokens = 4000, timeoutMs = 90 * 1000 }) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.groq.apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  // Too much text for one request: the caller splits it and tries the halves.
  if (res.status === 413 || (res.status === 400 && /too large|context|tokens/i.test(data.error?.message || ''))) {
    throw Object.assign(new Error('This part is too long for the backup AI.'), { code: 'MAX_TOKENS' });
  }
  if (res.status === 404 || /decommissioned|does not exist|model_not_found/i.test(data.error?.message || data.error?.code || '')) return RETIRED;
  if (res.status === 429 || res.status >= 500) throw busy(res, data);
  if (!res.ok) throw new Error(`Groq error (${res.status}): ${data.error?.message || 'unknown'}`);
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') throw Object.assign(new Error('The backup AI answer was cut off.'), { code: 'MAX_TOKENS' });
  return choice?.message?.content || '';
}

/** Read study material from plain text (a pasted chunk, or the text layer of PDF pages). */
export async function extractWithGroq(text, { hint = '', existingTopics = {}, ...extra } = {}) {
  const out = await chat({
    system: `${SYSTEM}\n\nReply with one JSON object only, matching this JSON schema:\n${JSON.stringify(SCHEMA)}`,
    user: `${text}\n\n${extractInstructions(hint, existingTopics, extra)}`,
    json: true,
    maxTokens: 8000,
    timeoutMs: 3 * 60 * 1000,
  });
  try {
    const parsed = JSON.parse(out);
    return { kind: parsed.kind || 'notes', notes: parsed.notes || [], questions: parsed.questions || [] };
  } catch {
    throw Object.assign(new Error('The backup AI returned an unreadable answer for this part.'), { code: 'MAX_TOKENS' });
  }
}

export async function explainWithGroq(question, excerpts, { system = EXPLAIN_SYSTEM } = {}) {
  const context = notesContext(excerpts);
  const text = await chat({ system, user: `My notes:\n\n${context || '(no matching notes found)'}\n\nMy question: ${question}`, maxTokens: 1500, timeoutMs: 60 * 1000 });
  return text.trim();
}

/** Speech to text with Whisper on Groq. */
export async function transcribeWithGroq(buffer, mimeType) {
  if (Date.now() < restingUntil) throw new AiBusyError('Groq is resting after a rate limit.', restingUntil);
  const ext = (mimeType.split('/')[1] || 'ogg').split(';')[0].replace('mpeg', 'mp3');
  const form = new FormData();
  form.append('model', 'whisper-large-v3-turbo');
  form.append('file', new Blob([buffer], { type: mimeType }), `voice.${ext}`);
  form.append('prompt', 'NEET PG medical question. Drug and disease names in English.');
  const res = await fetch(`${BASE}/audio/transcriptions`, {
    method: 'POST',
    signal: AbortSignal.timeout(60 * 1000),
    headers: { Authorization: `Bearer ${config.groq.apiKey}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 429 || res.status >= 500) throw busy(res, data);
  if (!res.ok) throw new Error(`Groq transcription error (${res.status}): ${data.error?.message || 'unknown'}`);
  return String(data.text || '').trim();
}

/** Startup check: is the key valid, and which Llama models does Groq offer right now? */
export async function checkGroq() {
  const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${config.groq.apiKey}` }, signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return `Groq key check failed (${res.status}): ${data.error?.message || 'unknown'}`;
  const llama = (data.data || []).map((m) => m.id).filter((id) => /llama/i.test(id));
  const usable = MODELS().filter((m) => llama.includes(m));
  return `Groq key OK. Llama models: ${llama.join(', ') || 'none'}. Will use: ${usable.join(' → ') || 'none of the configured ones; set GROQ_MODEL'}`;
}

/** For tests. */
export function resetGroq() {
  restingUntil = 0;
  retired.clear();
}
