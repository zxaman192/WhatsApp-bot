import 'dotenv/config';

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

export function isAllowed(phone) {
  return config.allowedNumbers.length === 0 || config.allowedNumbers.includes(String(phone));
}
