import 'dotenv/config';
import { createHash } from 'node:crypto';

const env = process.env;

export const config = {
  whatsapp: {
    token: env.WHATSAPP_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: env.WHATSAPP_APP_SECRET || '',
    graphVersion: env.GRAPH_API_VERSION || 'v21.0',
  },
  allowedNumbers: (env.ALLOWED_NUMBERS || '')
    .split(',')
    .map((n) => n.replace(/\D/g, ''))
    .filter(Boolean),
  telegram: {
    token: env.TELEGRAM_BOT_TOKEN || '',
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
  anthropic: {
    apiKey: env.ANTHROPIC_API_KEY || '',
    model: env.CLAUDE_MODEL || 'claude-opus-5-5',
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
