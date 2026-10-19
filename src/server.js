import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { initDb } from './db.js';
import { handleMessage } from './bot.js';
import { registerWebhook, toBotMessage } from './telegram.js';
import { startScheduler, runDueDailies } from './scheduler.js';

const app = express();
// Keep the raw body so the webhook signature can be checked.
app.use(express.json({ limit: '5mb', verify: (req, _res, buf) => (req.rawBody = buf) }));

function validSignature(req) {
  if (!config.whatsapp.appSecret) return true; // not configured: accept (only for local testing)
  const header = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + createHmac('sha256', config.whatsapp.appSecret).update(req.rawBody || '').digest('hex');
  return header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

app.get('/', (_req, res) => res.send('NEET PG bot is running.'));
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
  if (!validSignature(req)) return res.sendStatus(401);
  res.sendStatus(200);
  for (const entry of req.body?.entry || []) {
    for (const change of entry.changes || []) {
      for (const msg of change.value?.messages || []) {
        // Meta retries deliveries; ignore ones we've already handled.
        if (seen.has(msg.id)) continue;
        seen.add(msg.id);
        if (seen.size > 5000) seen.delete(seen.values().next().value);
        handleMessage(msg).catch((e) => console.error('handleMessage failed', e));
      }
    }
  }
});

// Telegram sends every update here.
app.post('/telegram', (req, res) => {
  if (!config.telegram.token || req.get('x-telegram-bot-api-secret-token') !== config.telegram.webhookSecret) {
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  const msg = toBotMessage(req.body || {});
  if (!msg || seen.has(msg.id)) return;
  seen.add(msg.id);
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
  registerWebhook(config.publicUrl)
    .then(() => console.log('Telegram webhook registered.'))
    .catch((e) => console.error('Telegram webhook registration failed:', e.message));
}
