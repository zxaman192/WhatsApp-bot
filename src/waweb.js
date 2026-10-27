// WhatsApp Web transport: the bot runs as a linked device on an ordinary WhatsApp number (like WhatsApp Web),
// so it needs no Meta business account. Used when WHATSAPP_MODE=web. The login lives in the wa_auth table
// so it survives restarts and deploys. Buttons and lists don't exist here, so they become numbered replies.
import { config } from './config.js';
import * as store from './db.js';
import * as tg from './telegram.js';

const LETTER_ROW = /^[A-D]$/;
const MAX_CODES = 3;

let baileys; // loaded on start so tests and the Cloud API mode never pull it in
let sock = null;
let ready = false;
let stopping = false;
let onMessage = null;
let codesSent = 0;
let linking = false; // a link code is out and the owner hasn't been told it worked yet
let readyWaiters = [];
const jids = new Map(); // phone → chat jid we last heard them on
const pending = new Map(); // phone → { number: button id }
const sent = new Map(); // message id → content, for WhatsApp's re-send requests

const digits = (s) => String(s || '').replace(/\D/g, '');
const log = (...a) => console.log('WhatsApp Web:', ...a);

/** Turn a Cloud API style payload into plain text plus the numbered choices it offers. */
export function renderPayload(payload) {
  if (payload.type === 'text') return { text: payload.text.body, choices: null };
  if (payload.type === 'template') return { text: '📚 Your daily question is ready. Reply *q* to get it.', choices: null };
  if (payload.type !== 'interactive') return { text: '', choices: null };
  const it = payload.interactive;
  let body = it.body?.text || '';
  const rows =
    it.type === 'button'
      ? it.action.buttons.map((b) => ({ id: b.reply.id, title: b.reply.title }))
      : it.action.sections.flatMap((s) => s.rows);
  const choices = {};
  const lines = [];
  // An answer list: the options are already in the question, and typing A-D (or 1-4) answers it.
  const answers = rows.filter((r) => LETTER_ROW.test(r.title) && r.id.startsWith('ans:'));
  let n = 1;
  if (answers.length) {
    body = body.replace(/_Tap ([^_]+) below\._/, '_Reply $1._');
    n = 5;
  }
  for (const r of rows) {
    if (answers.includes(r)) continue;
    choices[n] = r.id;
    lines.push(`*${n}.* ${r.title}${r.description ? ` · _${r.description}_` : ''}`);
    n++;
  }
  if (lines.length) body += `\n\n${lines.join('\n')}\n\n_Reply with a number._`;
  return { text: body, choices };
}

/** A bare number that picks one of the choices we last offered becomes a tap on it. */
export function mapReply(phone, text) {
  const m = String(text || '').trim().match(/^(\d{1,2})\.?$/);
  const id = m && pending.get(phone)?.[m[1]];
  return id ? { type: 'interactive', interactive: { list_reply: { id } } } : null;
}

export function rememberChoices(phone, choices) {
  if (choices) pending.set(phone, choices);
}

const jidFor = (phone) => jids.get(phone) || `${digits(phone)}@s.whatsapp.net`;

function whenReady(ms = 15000) {
  if (ready && sock) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WhatsApp Web is not connected')), ms);
    readyWaiters.push(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function deliver(phone, content) {
  await whenReady();
  const r = await sock.sendMessage(jidFor(phone), content);
  if (r?.key?.id) {
    sent.set(r.key.id, r.message);
    if (sent.size > 500) sent.delete(sent.keys().next().value);
  }
}

/** Send a Cloud API style payload. */
export async function send(payload) {
  const { text, choices } = renderPayload(payload);
  if (!text) return;
  rememberChoices(payload.to, choices);
  await deliver(payload.to, { text: text.slice(0, 4096) });
}

export const sendImage = (to, buffer, mimetype, caption = '') => deliver(to, { image: buffer, mimetype, caption });

export function typing(phone) {
  if (ready && sock) sock.sendPresenceUpdate('composing', jidFor(phone)).catch(() => {});
}

// ---------- login state in the database ----------

async function dbAuthState() {
  const { BufferJSON, initAuthCreds, proto } = baileys;
  const read = async (ids) => {
    const rows = await store.authGet(ids);
    return Object.fromEntries(Object.entries(rows).map(([id, d]) => [id, JSON.parse(d, BufferJSON.reviver)]));
  };
  const creds = (await read(['creds'])).creds || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const rows = await read(ids.map((id) => `${type}-${id}`));
          const out = {};
          for (const id of ids) {
            let v = rows[`${type}-${id}`];
            if (v && type === 'app-state-sync-key') v = proto.Message.AppStateSyncKeyData.fromObject(v);
            if (v) out[id] = v;
          }
          return out;
        },
        set: async (data) => {
          const entries = [];
          for (const type in data) {
            for (const id in data[type]) {
              const v = data[type][id];
              entries.push([`${type}-${id}`, v ? JSON.stringify(v, BufferJSON.replacer) : null]);
            }
          }
          await store.authSet(entries);
        },
      },
    },
    saveCreds: () => store.authSet([['creds', JSON.stringify(creds, BufferJSON.replacer)]]),
  };
}

// ---------- connection ----------

async function notifyOwner(text) {
  log(text.replace(/\*/g, ''));
  for (const id of config.telegram.allowedIds) await tg.sendText(`tg:${id}`, text).catch((e) => log('Telegram notice failed:', e.message));
}

async function connect() {
  const { default: makeWASocket, Browsers, DisconnectReason, fetchLatestBaileysVersion } = baileys;
  const { default: pino } = await import('pino');
  const { state, saveCreds } = await dbAuthState();
  const version = await fetchLatestBaileysVersion()
    .then((v) => v.version)
    .catch(() => undefined);
  const s = makeWASocket({
    auth: state,
    ...(version ? { version } : {}),
    browser: Browsers.macOS('Chrome'),
    logger: pino({ level: 'error' }),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async (key) => sent.get(key.id),
  });
  sock = s;
  let asked = false;

  s.ev.on('creds.update', () => saveCreds().catch((e) => log('saving login failed:', e.message)));

  s.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (s !== sock) return;
    if (qr && !state.creds.registered && !asked) {
      asked = true;
      if (codesSent >= MAX_CODES) {
        log('not linked; waiting for "link whatsapp" before sending another code.');
        stopping = true;
        s.end(undefined);
        return;
      }
      codesSent++;
      linking = true;
      try {
        const code = await s.requestPairingCode(digits(config.whatsapp.webNumber));
        const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
        await notifyOwner(
          `🔗 *WhatsApp link code: ${pretty}*\n\nOn the phone with +${digits(config.whatsapp.webNumber)}:\n1. Open WhatsApp → Settings → Linked devices\n2. Tap *Link a device*\n3. Tap *Link with phone number instead*\n4. Enter the code\n\n_The code expires in a few minutes. Send *link whatsapp* here for a new one._`
        );
      } catch (e) {
        log('pairing code request failed:', e.message);
      }
    }
    if (connection === 'open') {
      ready = true;
      codesSent = 0;
      log(`connected as ${s.user?.id?.split(':')[0] || 'unknown'}.`);
      const waiters = readyWaiters;
      readyWaiters = [];
      waiters.forEach((w) => w());
      if (linking) {
        linking = false;
        await notifyOwner('✅ *WhatsApp linked!* Message the bot number from your own WhatsApp to start.');
      }
    }
    if (connection === 'close') {
      ready = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        await store.authClear().catch(() => {});
        await notifyOwner('⚠️ *WhatsApp was unlinked from the bot.* Send *link whatsapp* here to link it again.');
        stopping = true;
        return;
      }
      if (stopping) return;
      // Another copy of the bot took over (a deploy): give the old one time to shut down before trying again.
      const wait = code === DisconnectReason.connectionReplaced ? 60000 : code === DisconnectReason.restartRequired ? 0 : 5000;
      log(`connection closed (${code || 'no code'}), reconnecting in ${wait / 1000}s.`);
      setTimeout(() => !stopping && connect().catch((e) => log('reconnect failed:', e.message)), wait);
    }
  });

  s.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) handleInbound(s, m).catch((e) => log('inbound failed:', e.message));
  });
}

function unwrap(message) {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    const inner = m.ephemeralMessage || m.viewOnceMessage || m.viewOnceMessageV2 || m.documentWithCaptionMessage;
    if (!inner) break;
    m = inner.message;
  }
  return m || {};
}

/** Turn a WhatsApp Web message into the bot's message shape. Exported for tests. */
export function toBotMessage(m, phone) {
  const c = unwrap(m.message);
  const base = { from: phone, id: m.key.id, firstName: m.pushName };
  const text = c.conversation || c.extendedTextMessage?.text;
  if (text) return { ...base, ...(mapReply(phone, text) || { type: 'text', text: { body: text } }) };
  if (c.imageMessage) return { ...base, type: 'image', image: { id: m.key.id, mime_type: c.imageMessage.mimetype, caption: c.imageMessage.caption || '' } };
  if (c.documentMessage)
    return {
      ...base,
      type: 'document',
      document: { id: m.key.id, mime_type: c.documentMessage.mimetype, filename: c.documentMessage.fileName || 'document', caption: c.documentMessage.caption || '' },
    };
  if (c.audioMessage) return { ...base, type: 'audio', audio: { id: m.key.id, mime_type: c.audioMessage.mimetype } };
  if (c.videoMessage) return { ...base, type: 'video', video: { id: m.key.id, mime_type: c.videoMessage.mimetype, caption: c.videoMessage.caption || '' } };
  return null;
}

async function handleInbound(s, m) {
  const { isJidGroup, isJidBroadcast, isJidStatusBroadcast, isJidNewsletter, jidNormalizedUser, downloadMediaMessage } = baileys;
  const jid = m.key.remoteJid;
  if (!jid || m.key.fromMe || isJidGroup(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid) || isJidNewsletter(jid)) return;
  // Newer chats arrive under a private id (@lid); the real number comes alongside it.
  let pn = jid.endsWith('@lid') ? m.key.remoteJidAlt || (await s.signalRepository?.lidMapping?.getPNForLID?.(jid).catch(() => null)) : jid;
  const phone = digits(jidNormalizedUser(pn || '').split('@')[0]);
  if (!phone) return log('could not tell which number a message came from.');
  jids.set(phone, jid);
  const msg = toBotMessage(m, phone);
  if (!msg) return;
  log(`${msg.type} from …${phone.slice(-4)}`);
  const download = async () => {
    const buffer = await downloadMediaMessage(m, 'buffer', {}, { reuploadRequest: s.updateMediaMessage });
    const c = unwrap(m.message);
    const media = c.imageMessage || c.documentMessage || c.audioMessage || c.videoMessage || {};
    return { buffer, mimeType: media.mimetype };
  };
  await onMessage(msg, { download });
}

/** Connect (called once at startup in web mode). handler(msg, opts) is the bot's message handler. */
export async function start(handler) {
  onMessage = handler;
  if (!digits(config.whatsapp.webNumber)) return log('set WHATSAPP_WEB_NUMBER to the bot\'s phone number.');
  baileys = await import('@whiskeysockets/baileys');
  stopping = false;
  await connect();
}

/** Start over with a fresh link code (the owner's "link whatsapp" command). */
export async function relink() {
  if (!baileys) return 'WhatsApp Web mode is off.';
  if (ready) return '✅ WhatsApp is already linked.';
  codesSent = 0;
  stopping = false;
  const old = sock;
  sock = null;
  old?.end(undefined);
  await connect();
  return '🔗 Getting a new link code…';
}

export function stop() {
  stopping = true;
  sock?.end(undefined);
}

export const isReady = () => ready;
