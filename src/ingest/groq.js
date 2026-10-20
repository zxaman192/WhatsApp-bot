// Groq (free key from console.groq.com), Llama when offered: the backup when every Gemini model is out of free quota.
// Text only, so PDFs fall back to their selectable text; voice notes use Groq's Whisper.
import { config } from '../config.js';
import { AiBusyError } from './gemini.js';
import { SCHEMA, SYSTEM, extractInstructions, notesContext, EXPLAIN_SYSTEM } from './claude.js';

export const groqAvailable = () => Boolean(config.groq.apiKey);

const BASE = 'https://api.groq.com/openai/v1';
let restingUntil = 0;
// Groq retires models often (Llama chat models were gone by late 2026), so the startup check picks the
// best chat model Groq offers; these names are only the fallback before that check has run.
let offered = null;
const PREFER = [/llama.*(70b|maverick|scout)/i, /gpt-oss-120b/i, /qwen/i, /kimi/i, /llama/i, /gpt-oss/i, /./];
const NOT_CHAT = /guard|whisper|tts|orpheus|playai|distil|compound/i;
const MODELS = () => {
  if (!offered) return [...new Set([config.groq.model, 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'])];
  const chat = offered.filter((m) => !NOT_CHAT.test(m));
  const ranked = PREFER.flatMap((re) => chat.filter((m) => re.test(m)));
  return [...new Set([...(chat.includes(config.groq.model) ? [config.groq.model] : []), ...ranked])];
};
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
  const whisper = offered?.filter((m) => /whisper/i.test(m)) || [];
  form.append('model', whisper.find((m) => /turbo/.test(m)) || whisper[0] || 'whisper-large-v3-turbo');
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

/** Startup check: is the key valid, and which chat models does Groq offer right now? */
export async function checkGroq() {
  const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${config.groq.apiKey}` }, signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return `Groq key check failed (${res.status}): ${data.error?.message || 'unknown'}`;
  offered = (data.data || []).map((m) => m.id);
  return `Groq key OK. Offered: ${offered.join(', ')}. Will use: ${MODELS().slice(0, 3).join(' → ') || 'none'}`;
}

/** For tests. */
export function resetGroq() {
  restingUntil = 0;
  offered = null;
  retired.clear();
}
