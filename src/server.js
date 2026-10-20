import express from 'express';
import dns from 'node:dns';
import net from 'node:net';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { initDb } from './db.js';
import { handleMessage } from './bot.js';
import { registerWebhook, toBotMessage, webhookInfo } from './telegram.js';
import { checkWhatsApp } from './whatsapp.js';
import { startScheduler, runDueDailies } from './scheduler.js';
import { groqAvailable, checkGroq } from './ingest/groq.js';

// Node tries IPv6 and IPv4 with a 250 ms connect timeout each; on Render that made calls to
// api.telegram.org fail with ETIMEDOUT. Prefer IPv4 and give each attempt longer.
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamilyAttemptTimeout(3000);

const app = express();
// Keep the raw body so the webhook signature can be checked.
app.use(express.json({ limit: '5mb', verify: (req, _res, buf) => (req.rawBody = buf) }));

function validSignature(req) {
  // Without the app secret anyone could post fake messages, so that's only allowed while nothing is really sent.
  if (!config.whatsapp.appSecret) return config.dryRun;
  const header = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + createHmac('sha256', config.whatsapp.appSecret).update(req.rawBody || '').digest('hex');
  return header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

app.get('/', (_req, res) => res.send('NEET PG bot is running.'));
// Meta needs a privacy policy and data-deletion page before a WhatsApp app can be published.
const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<style>body{font:16px/1.6 system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 16px;color:#222}h1{font-size:24px}</style></head>` +
  `<body><h1>${title}</h1>${body}</body></html>`;
app.get('/privacy', (_req, res) =>
  res.send(
    page(
      'NEET PG Study Bot: Privacy Policy',
      `<p>This is a private study bot used by its owner and people the owner allows. It stores your phone number or Telegram ID, the messages and files you send it, your answers to practice questions, and your settings (daily question time, exam date, name).</p>
<p>This data is used only to run the bot: to file your study material, ask you questions, track your progress and send your daily question. It is stored in the bot's own database and is not sold or shared. Uploaded material may be sent to an AI service (Google Gemini or Groq) to read it and write questions.</p>
<p>To have your data deleted, see the <a href="/data-deletion">data deletion instructions</a>.</p>`
    )
  )
);
app.get('/data-deletion', (_req, res) =>
  res.send(
    page(
      'NEET PG Study Bot: Data Deletion',
      `<p>To delete your data, send the message <b>delete my data</b> to the bot on WhatsApp or Telegram, or ask the bot's owner. Your answers, progress and settings are then removed within 7 days. Study material you uploaded can be removed from the bot's Database menu.</p>`
    )
  )
);
app.get('/health', (_req, res) => res.json({ ok: true, dryRun: config.dryRun }));

// Meta calls this once when you save the webhook URL.
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.whatsapp.verifyToken && config.whatsapp.verifyToken) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// Every incoming message lands here. Reply 200 at once; reading a big PDF can take minutes.
const seen = new Set();
app.post('/webhook', (req, res) => {
  if (!validSignature(req)) {
    console.warn(config.whatsapp.appSecret ? 'WhatsApp webhook rejected: bad signature.' : 'WhatsApp webhook rejected: set WHATSAPP_APP_SECRET before going live.');
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  for (const entry of req.body?.entry || []) {
    for (const change of entry.changes || []) {
      // Meta accepts a reply first and reports a failed delivery later, here.
      for (const st of change.value?.statuses || []) {
        if (st.status === 'failed') {
          const err = st.errors?.[0] || {};
          console.warn(`WhatsApp reply to …${String(st.recipient_id).slice(-4)} failed: ${err.code || ''} ${err.title || ''} ${err.error_data?.details || err.message || ''}`.trim());
        }
      }
      for (const msg of change.value?.messages || []) {
        // Meta retries deliveries; ignore ones we've already handled.
        if (seen.has(msg.id)) continue;
        seen.add(msg.id);
        if (seen.size > 5000) seen.delete(seen.values().next().value);
        console.log(`WhatsApp update: ${msg.type} from …${String(msg.from).slice(-4)}`);
        handleMessage(msg).catch((e) => console.error('handleMessage failed', e));
      }
    }
  }
});

// Telegram sends every update here.
app.post('/telegram', (req, res) => {
  if (!config.telegram.token || req.get('x-telegram-bot-api-secret-token') !== config.telegram.webhookSecret) {
    console.warn('Telegram update rejected: secret token did not match.');
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  const msg = toBotMessage(req.body || {});
  console.log(`Telegram update: ${msg ? `${msg.type} from ${msg.from}` : 'ignored'}`);
  if (!msg || seen.has(msg.id)) return;
  seen.add(msg.id);
  if (seen.size > 5000) seen.delete(seen.values().next().value);
  handleMessage(msg).catch((e) => console.error('handleMessage failed', e));
});

// Optional: an external cron (e.g. Render cron job) can hit this to make sure dailies go out
// even if the free instance was asleep. Protected by the verify token.
app.post('/cron/daily', async (req, res) => {
  if (req.get('x-cron-token') !== config.whatsapp.verifyToken || !config.whatsapp.verifyToken) return res.sendStatus(403);
  res.json({ sent: await runDueDailies() });
});

if (process.env.RENDER && !config.databaseUrl) {
  // The embedded database is for local testing only: it doesn't fit in a small instance and is wiped on every deploy.
  console.error('DATABASE_URL is not set. Add your Supabase connection string in the Render environment settings.');
  process.exit(1);
}
await initDb();
console.log(`Database ready (${config.databaseUrl ? 'Postgres' : 'local PGlite'}).`);
startScheduler();
app.listen(config.port, () => {
  console.log(`NEET PG bot listening on :${config.port} (${config.dryRun ? 'DRY_RUN, not sending' : 'live'})`);
});
if (config.telegram.token && config.publicUrl) {
  console.log(`Registering Telegram webhook at ${config.publicUrl}/telegram…`);
  registerWebhook(config.publicUrl)
    .then(() => console.log('Telegram webhook registered.'))
    .then(() => webhookInfo())
    .then((i) => console.log(`Telegram webhook info: pending=${i.pending_update_count}${i.last_error_message ? `, last error: ${i.last_error_message}` : ''}`))
    .catch((e) => console.error('Telegram webhook registration failed:', e.message));
}
if (!config.dryRun) checkWhatsApp().then(console.log).catch((e) => console.error('WhatsApp check failed:', e.message));
if (groqAvailable()) checkGroq().then(console.log).catch((e) => console.error('Groq key check failed:', e.message));
