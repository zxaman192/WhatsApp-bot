// Postgres storage. In production this is Supabase (DATABASE_URL). Without DATABASE_URL
// (local testing, the terminal simulator, tests) it uses PGlite, an embedded Postgres.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { config } from './config.js';

let db; // { query(text, params) => { rows } , close() }

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sources (
    id SERIAL PRIMARY KEY,
    filename TEXT,
    kind TEXT,
    added_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS questions (
    id SERIAL PRIMARY KEY,
    subject TEXT NOT NULL,
    topic TEXT NOT NULL DEFAULT 'General',
    stem TEXT NOT NULL,
    options JSONB NOT NULL,              -- array of 4 strings
    answer INT NOT NULL,                 -- 0-based index into options
    explanation TEXT NOT NULL DEFAULT '',
    year TEXT NOT NULL DEFAULT '',       -- PYQ year, if known
    exam TEXT NOT NULL DEFAULT '',       -- e.g. NEET PG, INI-CET
    answer_checked BOOLEAN NOT NULL DEFAULT true, -- false = answer worked out by AI, not given in the source
    origin TEXT NOT NULL DEFAULT 'bank', -- bank | pyq | notes
    source_id INT REFERENCES sources(id) ON DELETE SET NULL,
    page INT,                            -- page in the uploaded file, when known
    hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT now(),
    search tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('english', subject || ' ' || topic), 'A') ||
      setweight(to_tsvector('english', stem), 'A') ||
      setweight(to_tsvector('english', options::text || ' ' || explanation), 'C')
    ) STORED
  );
  CREATE INDEX IF NOT EXISTS idx_questions_subject ON questions(subject, topic);
  CREATE INDEX IF NOT EXISTS idx_questions_search ON questions USING gin(search);
  CREATE TABLE IF NOT EXISTS notes (
    id SERIAL PRIMARY KEY,
    subject TEXT NOT NULL,
    topic TEXT NOT NULL DEFAULT 'General',
    content TEXT NOT NULL,
    source_id INT REFERENCES sources(id) ON DELETE SET NULL,
    page INT,
    created_at TIMESTAMPTZ DEFAULT now(),
    search tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('english', subject || ' ' || topic), 'A') ||
      setweight(to_tsvector('english', content), 'B')
    ) STORED
  );
  CREATE INDEX IF NOT EXISTS idx_notes_subject ON notes(subject, topic);
  CREATE INDEX IF NOT EXISTS idx_notes_search ON notes USING gin(search);
  CREATE TABLE IF NOT EXISTS attempts (
    id SERIAL PRIMARY KEY,
    phone TEXT NOT NULL,
    question_id INT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    chosen INT NOT NULL,
    correct BOOLEAN NOT NULL,
    mode TEXT NOT NULL,                  -- daily | test | single
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_attempts_phone ON attempts(phone, question_id);
  CREATE TABLE IF NOT EXISTS users (
    phone TEXT PRIMARY KEY,
    daily_enabled BOOLEAN NOT NULL DEFAULT true,
    daily_time TEXT NOT NULL,
    daily_subject TEXT,                  -- optional: limit the daily question to one subject
    last_daily_date TEXT,
    last_inbound_at TIMESTAMPTZ,
    state JSONB NOT NULL DEFAULT '{}'    -- current question / test in progress
  );
  -- The bot connects with the database owner role; keep the tables out of Supabase's public REST API.
  ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
  ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
  ALTER TABLE attempts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE users ENABLE ROW LEVEL SECURITY;
`;

/** Connect and create tables. url: Postgres URL, 'memory' for an in-memory PGlite, or a PGlite data dir. */
export async function initDb(url = config.databaseUrl || config.pgliteDir) {
  if (/^postgres(ql)?:\/\//.test(url)) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: url,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
      max: 5,
    });
    db = { query: (t, p) => pool.query(t, p), close: () => pool.end() };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    if (url !== 'memory') mkdirSync(url, { recursive: true });
    const lite = url === 'memory' ? new PGlite() : new PGlite(url);
    db = { query: (t, p) => lite.query(t, p), close: () => lite.close() };
    await lite.exec(SCHEMA);
    return db;
  }
  await db.query(SCHEMA);
  return db;
}

const q = (text, params = []) => db.query(text, params).then((r) => r.rows);
const one = async (text, params) => (await q(text, params))[0];

export async function closeDb() {
  await db?.close();
  db = undefined;
}

// ---------- users ----------

export async function getUser(phone) {
  await q('INSERT INTO users (phone, daily_time) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING', [
    phone,
    config.defaultDailyTime,
  ]);
  return one('SELECT * FROM users WHERE phone = $1', [phone]);
}

const USER_COLS = new Set(['daily_enabled', 'daily_time', 'daily_subject', 'last_daily_date', 'last_inbound_at', 'state']);

export async function updateUser(phone, fields) {
  const cols = Object.keys(fields).filter((c) => USER_COLS.has(c));
  if (!cols.length) return;
  const values = cols.map((c) => (c === 'state' ? JSON.stringify(fields[c]) : fields[c]));
  await q(`UPDATE users SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE phone = $${cols.length + 1}`, [
    ...values,
    phone,
  ]);
}

export const allUsers = () => q('SELECT * FROM users');

// ---------- sources / questions / notes ----------

export async function addSource(filename, kind, addedBy) {
  const r = await one('INSERT INTO sources (filename, kind, added_by) VALUES ($1, $2, $3) RETURNING id', [
    filename,
    kind,
    addedBy || null,
  ]);
  return r.id;
}

export function questionHash(stem, options) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return createHash('sha1')
    .update(norm(stem) + '|' + [...options].map(norm).sort().join('|'))
    .digest('hex');
}

/** Insert a question; returns true if it was new, false if it was a duplicate. */
export async function addQuestion(x) {
  const rows = await q(
    `INSERT INTO questions
       (subject, topic, stem, options, answer, explanation, year, exam, answer_checked, origin, source_id, page, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (hash) DO NOTHING RETURNING id`,
    [
      x.subject,
      x.topic || 'General',
      x.stem,
      JSON.stringify(x.options),
      x.answer,
      x.explanation || '',
      x.year || '',
      x.exam || '',
      x.answerChecked !== false,
      x.origin || 'bank',
      x.sourceId ?? null,
      x.page || null,
      questionHash(x.stem, x.options),
    ]
  );
  return rows.length > 0;
}

export async function addNote(n) {
  await q('INSERT INTO notes (subject, topic, content, source_id, page) VALUES ($1, $2, $3, $4, $5)', [
    n.subject,
    n.topic || 'General',
    n.content,
    n.sourceId ?? null,
    n.page || null,
  ]);
}

export function getQuestion(id) {
  return one(
    `SELECT q.id, q.subject, q.topic, q.stem, q.options, q.answer, q.explanation, q.year, q.exam,
            q.answer_checked, q.origin, q.page, s.filename
     FROM questions q LEFT JOIN sources s ON s.id = q.source_id WHERE q.id = $1`,
    [id]
  );
}

export async function recordAttempt(phone, questionId, chosen, correct, mode) {
  await q('INSERT INTO attempts (phone, question_id, chosen, correct, mode) VALUES ($1, $2, $3, $4, $5)', [
    phone,
    questionId,
    chosen,
    correct,
    mode,
  ]);
}

/**
 * Pick questions for a user. Order of preference:
 *   1. questions they got wrong last time (spaced review), about a third of a test
 *   2. questions they have never seen
 *   3. the ones they saw longest ago
 */
export async function pickQuestions(phone, { count = 1, subject = null, topic = null, pyqOnly = false, year = null, wrongOnly = false, ids = null } = {}) {
  const where = [];
  const params = [phone];
  if (ids) { params.push(ids); where.push(`q.id = ANY($${params.length}::int[])`); }
  if (subject) { params.push(subject); where.push(`q.subject = $${params.length}`); }
  if (topic) { params.push(`%${topic}%`); where.push(`q.topic ILIKE $${params.length}`); }
  if (pyqOnly) where.push("q.origin = 'pyq'");
  if (year) { params.push(String(year)); where.push(`q.year = $${params.length}`); }

  const rows = await q(
    `SELECT q.id, la.correct AS last_correct, la.created_at AS last_seen
     FROM questions q
     LEFT JOIN LATERAL (
       SELECT a.correct, a.created_at FROM attempts a
       WHERE a.phone = $1 AND a.question_id = q.id ORDER BY a.id DESC LIMIT 1
     ) la ON true
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
    params
  );

  const shuffle = (arr) => arr.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
  const wrong = shuffle(rows.filter((r) => r.last_correct === false));
  if (wrongOnly) return wrong.slice(0, count).map((r) => r.id);
  const unseen = shuffle(rows.filter((r) => r.last_seen == null));
  const seen = rows.filter((r) => r.last_correct === true).sort((a, b) => new Date(a.last_seen) - new Date(b.last_seen));

  const reviewSlots = count === 1 ? 0 : Math.min(wrong.length, Math.max(1, Math.round(count / 3)));
  const picked = wrong.slice(0, reviewSlots);
  for (const pool of [unseen, wrong.slice(reviewSlots), seen]) {
    for (const r of pool) {
      if (picked.length >= count) break;
      picked.push(r);
    }
  }
  return shuffle(picked).map((r) => r.id);
}

export async function countQuestions({ subject = null, topic = null } = {}) {
  const r = await one(
    `SELECT COUNT(*)::int AS n FROM questions
     WHERE ($1::text IS NULL OR subject = $1) AND ($2::text IS NULL OR topic ILIKE '%' || $2 || '%')`,
    [subject, topic]
  );
  return r.n;
}

export const bankSummary = () =>
  q(
    `SELECT subject, topic, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE origin = 'pyq')::int AS pyq
     FROM questions GROUP BY subject, topic ORDER BY subject, n DESC`
  );

export const notesSummary = () =>
  q('SELECT subject, COUNT(DISTINCT topic)::int AS topics, COUNT(*)::int AS sections FROM notes GROUP BY subject ORDER BY subject');

export async function userStats(phone) {
  const overall = await one(
    'SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE correct)::int AS c FROM attempts WHERE phone = $1',
    [phone]
  );
  const bySubject = await q(
    `SELECT q.subject, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE a.correct)::int AS c
     FROM attempts a JOIN questions q ON q.id = a.question_id
     WHERE a.phone = $1 GROUP BY q.subject ORDER BY n DESC`,
    [phone]
  );
  const weakTopics = await q(
    `SELECT q.subject, q.topic, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE a.correct)::int AS c
     FROM attempts a JOIN questions q ON q.id = a.question_id
     WHERE a.phone = $1 GROUP BY q.subject, q.topic HAVING COUNT(*) >= 3
     ORDER BY COUNT(*) FILTER (WHERE a.correct)::float / COUNT(*) ASC LIMIT 5`,
    [phone]
  );
  const week = await one(
    `SELECT COUNT(DISTINCT date(created_at))::int AS days FROM attempts
     WHERE phone = $1 AND created_at >= now() - interval '7 days'`,
    [phone]
  );
  return { overall, bySubject, weakTopics, activeDaysThisWeek: week.days };
}

export async function existingTopics() {
  const out = {};
  const rows = await q('SELECT subject, topic FROM questions UNION SELECT subject, topic FROM notes ORDER BY 1, 2');
  for (const r of rows) (out[r.subject] ??= []).push(r.topic);
  return out;
}

// ---------- search ----------

const STOPWORDS = new Set(
  ('a an the of in on at to for from by with and or not is are was were be been which what who whom whose when where why how ' +
    'all following except true false most least best common commonly seen given used use this that these those it its ' +
    'as into than then there their they he she his her him patient year old years man woman presents presented ' +
    'explain tell me about where find show topic notes note question questions please can you do does did my').split(' ')
);

/** Meaningful words of a free-text query, for an OR-style full-text search. */
export function searchTerms(text) {
  const words = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, 12);
}

// Try "all words" first; if that finds nothing, fall back to "any word".
async function withFallback(text, run) {
  const terms = searchTerms(text);
  if (!terms.length) return [];
  const all = await run(terms.join(' & '));
  return all.length || terms.length === 1 ? all : run(terms.join(' | '));
}

export function searchNotes(text, opts) {
  return withFallback(text, (tq) => searchNotesTs(tq, opts));
}

export function searchQuestions(text, opts) {
  return withFallback(text, (tq) => searchQuestionsTs(tq, opts));
}

async function searchNotesTs(tq, { limit = 5, subject = null } = {}) {
  const params = [tq, limit];
  if (subject) params.push(subject);
  return q(
    `SELECT n.id, n.subject, n.topic, n.content, n.page, s.filename,
            ts_headline('english', n.content, to_tsquery('english', $1),
                        'MaxWords=30, MinWords=12, StartSel=*, StopSel=*, MaxFragments=2, FragmentDelimiter=" … "') AS snippet,
            ts_rank_cd(n.search, to_tsquery('english', $1)) AS rank
     FROM notes n LEFT JOIN sources s ON s.id = n.source_id
     WHERE n.search @@ to_tsquery('english', $1) ${subject ? 'AND n.subject = $3' : ''}
     ORDER BY rank DESC LIMIT $2`,
    params
  );
}

async function searchQuestionsTs(tq, { limit = 50 } = {}) {
  return q(
    `SELECT q.id, q.subject, q.topic, q.stem, q.origin, q.year, q.page, s.filename,
            ts_rank_cd(q.search, to_tsquery('english', $1)) AS rank
     FROM questions q LEFT JOIN sources s ON s.id = q.source_id
     WHERE q.search @@ to_tsquery('english', $1)
     ORDER BY rank DESC LIMIT $2`,
    [tq, limit]
  );
}
