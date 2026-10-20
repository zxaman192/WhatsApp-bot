import 'dotenv/config';
import { createHash } from 'node:crypto';

const env = process.env;

export const config = {
  whatsapp: {
    token: env.WHATSAPP_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: env.WHATSAPP_APP_SECRET || '',
    // WhatsApp Business Account id: with it the server makes sure Meta delivers this account's messages to the app.
    businessAccountId: env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
    graphVersion: env.GRAPH_API_VERSION || 'v21.0',
  },
  allowedNumbers: (env.ALLOWED_NUMBERS || '')
    .split(',')
    .map((n) => n.replace(/\D/g, ''))
    .filter(Boolean),
  telegram: {
    token: env.TELEGRAM_BOT_TOKEN || '',
    // Telegram bots only ever reply to people who message them, and only allowed ids get past the first
    // reply, so Telegram is live by default. DRY_RUN applies to WhatsApp.
    dryRun: (env.TELEGRAM_DRY_RUN || 'false').toLowerCase() === 'true',
    // Telegram sends this back on every webhook call so we know the request is genuine.
    webhookSecret:
      env.TELEGRAM_WEBHOOK_SECRET ||
      (env.TELEGRAM_BOT_TOKEN ? createHash('sha256').update('tg-webhook:' + env.TELEGRAM_BOT_TOKEN).digest('hex').slice(0, 48) : ''),
    // Telegram user ids allowed to use the bot. Empty = nobody; the bot tells a new user their id.
    allowedIds: (env.TELEGRAM_ALLOWED_IDS || '')
      .split(',')
      .map((n) => n.replace(/\D/g, ''))
      .filter(Boolean),
  },
  // Public https address of this server, used to register the Telegram webhook. Render sets RENDER_EXTERNAL_URL.
  publicUrl: env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '',
  // claude | gemini | none. Empty = use whichever key is set (Gemini first).
  aiProvider: (env.AI_PROVIDER || '').toLowerCase(),
  gemini: {
    apiKey: env.GEMINI_API_KEY || '',
    model: env.GEMINI_MODEL || 'gemini-3.6-flash',
    // Tried in order when the main model is out of free quota or overloaded (each model has its own quota).
    fallbackModels: (env.GEMINI_FALLBACK_MODELS || 'gemini-3.5-flash,gemini-3-flash-preview,gemini-3.7-flash,gemini-3.8-flash,gemini-3.5-flash-lite,gemini-flash-lite-latest')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
  },
  // Backup when every Gemini model is out of free quota: Llama on Groq (free key at console.groq.com).
  groq: {
    apiKey: env.GROQ_API_KEY || '',
    model: env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  },
  anthropic: {
    apiKey: env.ANTHROPIC_API_KEY || '',
    model: env.CLAUDE_MODEL || 'claude-haiku-5-5',
  },
  timezone: env.TIMEZONE || 'Asia/Kolkata',
  defaultDailyTime: env.DEFAULT_DAILY_TIME || '07:00',
  dailyTemplate: {
    name: env.DAILY_TEMPLATE_NAME || '',
    lang: env.DAILY_TEMPLATE_LANG || 'en',
  },
  port: Number(env.PORT || 3000),
  // Supabase Postgres connection string. Leave empty to use a local embedded database in PGLITE_DIR.
  databaseUrl: env.DATABASE_URL || '',
  pgliteDir: env.PGLITE_DIR || 'data/pglite',
  dryRun: (env.DRY_RUN || 'true').toLowerCase() !== 'false',
};

export function isAllowed(id) {
  if (String(id).startsWith('tg:')) return config.telegram.allowedIds.includes(String(id).slice(3));
  return config.allowedNumbers.length === 0 || config.allowedNumbers.includes(String(id));
}
