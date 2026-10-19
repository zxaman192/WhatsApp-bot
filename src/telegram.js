// Telegram Bot API transport. Telegram users are stored as "tg:<chat id>" so they share
// the same database (question bank, notes) as WhatsApp users.
import { config } from './config.js';

const api = (method) => `https://api.telegram.org/bot${config.telegram.token}/${method}`;

export const isTelegramId = (id) => String(id).startsWith('tg:');
const chatId = (id) => String(id).slice(3);

let sink = (to, payload) => console.log(`[DRY_RUN → ${to}]`, JSON.stringify(payload, null, 2));
export function setSink(fn) {
  sink = fn;
}

async function call(method, body) {
  const res = await fetch(api(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method} failed (${res.status}): ${data.description || 'unknown error'}`);
  return data.result;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

async function send(to, text, keyboard) {
  const payload = {
    chat_id: chatId(to),
    text: clip(text, 4096),
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  };
  if (config.telegram.dryRun) return sink(to, { type: 'telegram', ...payload });
  try {
    await call('sendMessage', payload);
  } catch (e) {
    // WhatsApp-style *bold* is valid Telegram Markdown, but a stray _ or [ (e.g. in a file name) breaks parsing.
    if (!/parse entities/i.test(e.message)) throw e;
    delete payload.parse_mode;
    await call('sendMessage', payload);
  }
}

export const sendText = (to, body) => send(to, body);

export const sendButtons = (to, body, buttons) =>
  send(to, body, [buttons.map((b) => ({ text: b.title, callback_data: b.id }))]);

export function sendList(to, body, _label, rows) {
  // Short labels (A–D answer buttons) go on one row; longer ones get a row each.
  const short = rows.every((r) => r.title.length <= 2);
  const keyboard = short
    ? [rows.map((r) => ({ text: r.title, callback_data: r.id }))]
    : rows.map((r) => [{ text: clip(r.description ? `${r.title} · ${r.description}` : r.title, 60), callback_data: r.id }]);
  return send(to, body, keyboard);
}

/** Download a file a user sent. Bot API limit: 20 MB. */
export async function downloadFile(fileId) {
  const file = await call('getFile', { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`);
  if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`);
  return { buffer: Buffer.from(await res.arrayBuffer()), mimeType: null };
}

export function answerCallback(callbackId) {
  if (config.telegram.dryRun) return;
  return call('answerCallbackQuery', { callback_query_id: callbackId }).catch(() => {});
}

/** Point Telegram at our webhook. Called on startup when a public URL is known. */
export async function registerWebhook(publicUrl) {
  await call('setWebhook', {
    url: `${publicUrl.replace(/\/$/, '')}/telegram`,
    secret_token: config.telegram.webhookSecret,
    allowed_updates: ['message', 'callback_query'],
  });
  await call('setMyCommands', {
    commands: [
      { command: 'q', description: 'One question now' },
      { command: 'test', description: 'Start a test' },
      { command: 'revise', description: 'Retry wrong answers' },
      { command: 'bank', description: "What's in the database" },
      { command: 'stats', description: 'Your progress' },
      { command: 'help', description: 'All commands' },
    ],
  });
}

/**
 * Turn a Telegram update into the same message shape the WhatsApp webhook gives us,
 * so bot.js handles both. Returns null for updates we ignore.
 */
export function toBotMessage(update) {
  if (update.callback_query) {
    const cq = update.callback_query;
    return {
      from: `tg:${cq.message.chat.id}`,
      id: `tg-cb-${cq.id}`,
      callbackId: cq.id,
      type: 'interactive',
      interactive: { list_reply: { id: cq.data } },
    };
  }
  const m = update.message;
  if (!m) return null;
  const base = { from: `tg:${m.chat.id}`, id: `tg-${m.chat.id}-${m.message_id}`, username: m.from?.username };
  if (m.document) {
    return {
      ...base,
      type: 'document',
      document: { id: m.document.file_id, mime_type: m.document.mime_type, filename: m.document.file_name, caption: m.caption || '' },
    };
  }
  if (m.photo?.length) {
    const largest = m.photo[m.photo.length - 1];
    return { ...base, type: 'image', image: { id: largest.file_id, mime_type: 'image/jpeg', caption: m.caption || '' } };
  }
  if (m.text) {
    // "/test pharma 20" → "test pharma 20"; also strips "@botname" from group-style commands.
    const body = m.text.startsWith('/') ? m.text.slice(1).replace(/^(\w+)@\w+/, '$1') : m.text;
    return { ...base, type: 'text', text: { body } };
  }
  return null;
}
