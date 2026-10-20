// Postgres storage. In production this is Supabase (DATABASE_URL). Without DATABASE_URL
// (local testing, the terminal simulator, tests) it uses PGlite, an embedded Postgres.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { config } from './config.js';
import { localNow, addDays } from './time.js';

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

  -- Added for spaced repetition, image questions, exam planner and study buddies.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS exam_date TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS buddy_group TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS last_weekly_date TEXT;
  ALTER TABLE questions ADD COLUMN IF NOT EXISTS image BYTEA;
  ALTER TABLE questions ADD COLUMN IF NOT EXISTS image_mime TEXT;
  CREATE TABLE IF NOT EXISTS reviews (
    phone TEXT NOT NULL,
    question_id INT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    box INT NOT NULL DEFAULT 0,          -- 0..3 → next gap of 1, 3, 7, 21 days
    due TEXT NOT NULL,                   -- YYYY-MM-DD in the bot's timezone
    PRIMARY KEY (phone, question_id)
  );
  CREATE TABLE IF NOT EXISTS group_daily (
    group_id TEXT NOT NULL,
    day TEXT NOT NULL,
    question_id INT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, day)
  );
  ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
  ALTER TABLE group_daily ENABLE ROW LEVEL SECURITY;

  -- Upload jobs: long PDFs are read part by part and survive restarts and AI quota pauses.
  CREATE TABLE IF NOT EXISTS upload_jobs (
    id SERIAL PRIMARY KEY,
    phone TEXT NOT NULL,
    filename TEXT,
    caption TEXT NOT NULL DEFAULT '',
    data BYTEA,                          -- the file, deleted when the job finishes
    source_id INT REFERENCES sources(id) ON DELETE SET NULL,
    parts INT NOT NULL DEFAULT 1,
    done_parts JSONB NOT NULL DEFAULT '[]',
    summary JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'running', -- running | paused | done | failed
    resume_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  ALTER TABLE upload_jobs ENABLE ROW LEVEL SECURITY;

  ALTER TABLE notes ADD COLUMN IF NOT EXISTS hash TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_hash ON notes(hash);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS buddy_code TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_buddy_code ON users(buddy_code);
  CREATE INDEX IF NOT EXISTS idx_attempts_phone_time ON attempts(phone, created_at);
  CREATE INDEX IF NOT EXISTS idx_attempts_question ON attempts(question_id);
  CREATE INDEX IF NOT EXISTS idx_reviews_phone_due ON reviews(phone, due);
  CREATE INDEX IF NOT EXISTS idx_users_buddy_group ON users(buddy_group) WHERE buddy_group IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_questions_origin ON questions(origin, subject);
`;

/** Connect and create tables. url: Postgres URL, 'memory' for an in-memory PGlite, or a PGlite data dir. */
export async function initDb(url = config.databaseUrl || config.pgliteDir) {
  if (/^postgres(ql)?:\/\//.test(url)) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: url,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 60000,
    });
    // Supabase's pooler drops idle connections now and then; without a listener that error would crash the server.
    pool.on('error', (e) => console.error('Idle database connection closed:', e.message));
    // A query that hits a just-dropped connection is retried once on a fresh one.
    const retryable = (e) => ['57P01', '08006', '08003'].includes(e.code) || /Connection terminated|ECONNRESET/i.test(e.message);
    db = {
      query: (t, p) => pool.query(t, p).catch((e) => (retryable(e) ? pool.query(t, p) : Promise.reject(e))),
      close: () => pool.end(),
    };
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

const USER_COLS = new Set(['daily_enabled', 'daily_time', 'daily_subject', 'last_daily_date', 'last_inbound_at', 'state', 'name', 'exam_date', 'buddy_group', 'last_weekly_date']);

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

/** Insert a note section; returns true if new, false if the same text was already filed under that subject. */
export async function addNote(n) {
  const norm = String(n.content).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const hash = createHash('sha1').update(`${n.subject}|${norm}`).digest('hex');
  const rows = await q(
    `INSERT INTO notes (subject, topic, content, source_id, page, hash) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (hash) DO NOTHING RETURNING id`,
    [n.subject, n.topic || 'General', n.content, n.sourceId ?? null, n.page || null, hash]
  );
  return rows.length > 0;
}

/** Mark a date field (last_daily_date / last_weekly_date) as done today; false if it already was. */
export async function claimDay(phone, field, date) {
  if (!['last_daily_date', 'last_weekly_date'].includes(field)) throw new Error(`bad field ${field}`);
  const rows = await q(`UPDATE users SET ${field} = $2 WHERE phone = $1 AND ${field} IS DISTINCT FROM $2 RETURNING phone`, [phone, date]);
  return rows.length > 0;
}

// ---------- upload jobs ----------

export async function createJob({ phone, filename, caption, data, sourceId, parts }) {
  const r = await one(
    `INSERT INTO upload_jobs (phone, filename, caption, data, source_id, parts) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [phone, filename, caption || '', data, sourceId, parts]
  );
  return r.id;
}

export const getJob = (id) => one('SELECT * FROM upload_jobs WHERE id = $1', [id]);

export async function updateJob(id, fields) {
  const cols = Object.keys(fields);
  const values = cols.map((c) => (['done_parts', 'summary'].includes(c) ? JSON.stringify(fields[c]) : fields[c]));
  await q(`UPDATE upload_jobs SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1}`, [...values, id]);
}

/** Jobs to pick up: interrupted by a restart (running), or paused for AI quota and due to resume. */
export const resumableJobs = () =>
  q(`SELECT id FROM upload_jobs WHERE status = 'running' OR (status = 'paused' AND resume_at <= now()) ORDER BY id`);

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
 *   1. spaced-repetition reviews that are due today (missed questions come back after 1, 3, 7, 21 days)
 *   2. questions they have never seen
 *   3. the ones they saw longest ago
 * Image ("spot") questions are asked separately.
 */
export async function pickQuestions(phone, { count = 1, subject = null, topic = null, pyqOnly = false, year = null, wrongOnly = false, ids = null } = {}) {
  const where = ["q.origin <> 'image'"];
  const params = [phone];
  if (ids) { params.push(ids); where.push(`q.id = ANY($${params.length}::int[])`); }
  if (subject) { params.push(subject); where.push(`q.subject = $${params.length}`); }
  if (topic) { params.push(`%${topic}%`); where.push(`q.topic ILIKE $${params.length}`); }
  if (pyqOnly) where.push("q.origin = 'pyq'");
  if (year) { params.push(String(year)); where.push(`q.year = $${params.length}`); }

  const rows = await q(
    `SELECT q.id, la.last_seen, r.due
     FROM questions q
     LEFT JOIN (
       SELECT question_id, MAX(created_at) AS last_seen FROM attempts WHERE phone = $1 GROUP BY question_id
     ) la ON la.question_id = q.id
     LEFT JOIN reviews r ON r.phone = $1 AND r.question_id = q.id
     WHERE ${where.join(' AND ')}`,
    params
  );

  const today = localNow().date;
  const inReview = rows.filter((r) => r.due != null).sort((a, b) => a.due.localeCompare(b.due));
  // "revise": everything still in the review queue, most overdue first.
  if (wrongOnly) return inReview.slice(0, count).map((r) => r.id);
  const due = inReview.filter((r) => r.due <= today);
  const unseen = shuffle(rows.filter((r) => r.last_seen == null));
  const seen = rows.filter((r) => r.last_seen != null && r.due == null).sort((a, b) => new Date(a.last_seen) - new Date(b.last_seen));

  // In a test, due reviews take at most a third of the slots; a single question is a due review if one is waiting.
  const reviewSlots = count === 1 ? Math.min(1, due.length) : Math.min(due.length, Math.max(1, Math.round(count / 3)));
  const picked = due.slice(0, reviewSlots);
  for (const pool of [unseen, due.slice(reviewSlots), seen, inReview.filter((r) => r.due > today)]) {
    for (const r of pool) {
      if (picked.length >= count) break;
      if (!picked.includes(r)) picked.push(r);
    }
  }
  return (count === 1 ? picked : shuffle(picked)).map((r) => r.id);
}

/** Fisher–Yates. */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- spaced repetition ----------

const REVIEW_GAPS = [1, 3, 7, 21];

/** Update the review schedule after an answer. Returns the next due date, or null if it left the queue. */
export async function scheduleReview(phone, questionId, correct) {
  const today = localNow().date;
  const cur = await one('SELECT box FROM reviews WHERE phone = $1 AND question_id = $2', [phone, questionId]);
  if (!correct) {
    const due = addDays(today, REVIEW_GAPS[0]);
    await q(
      `INSERT INTO reviews (phone, question_id, box, due) VALUES ($1, $2, 0, $3)
       ON CONFLICT (phone, question_id) DO UPDATE SET box = 0, due = $3`,
      [phone, questionId, due]
    );
    return due;
  }
  if (!cur) return null;
  const box = cur.box + 1;
  if (box >= REVIEW_GAPS.length) {
    await q('DELETE FROM reviews WHERE phone = $1 AND question_id = $2', [phone, questionId]);
    return null;
  }
  const due = addDays(today, REVIEW_GAPS[box]);
  await q('UPDATE reviews SET box = $3, due = $4 WHERE phone = $1 AND question_id = $2', [phone, questionId, box, due]);
  return due;
}

export async function reviewCounts(phone) {
  const today = localNow().date;
  return one(
    `SELECT COUNT(*) FILTER (WHERE due <= $2)::int AS due, COUNT(*)::int AS total FROM reviews WHERE phone = $1`,
    [phone, today]
  );
}

export async function countQuestions({ subject = null, topic = null } = {}) {
  const r = await one(
    `SELECT COUNT(*)::int AS n FROM questions
     WHERE origin <> 'image' AND ($1::text IS NULL OR subject = $1) AND ($2::text IS NULL OR topic ILIKE '%' || $2 || '%')`,
    [subject, topic]
  );
  return r.n;
}

export const bankSummary = () =>
  q(
    `SELECT subject, topic, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE origin = 'pyq')::int AS pyq
     FROM questions WHERE origin <> 'image' GROUP BY subject, topic ORDER BY subject, n DESC`
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
    `SELECT COUNT(DISTINCT date(created_at AT TIME ZONE $2))::int AS days FROM attempts
     WHERE phone = $1 AND created_at >= now() - interval '7 days'`,
    [phone, config.timezone]
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

// Short forms people type, expanded to the words the notes use.
const SHORTHAND = {
  doc: 'drug choice', moa: 'mechanism action', htn: 'hypertension', dm: 'diabetes', mi: 'myocardial infarction',
  tb: 'tuberculosis', ckd: 'chronic kidney', aki: 'acute kidney', copd: 'obstructive pulmonary', cad: 'coronary',
  chf: 'heart failure', cvs: 'cardiovascular', cns: 'nervous', gi: 'gastrointestinal', uti: 'urinary infection',
  sle: 'lupus', ra: 'rheumatoid arthritis', ibd: 'inflammatory bowel', dka: 'ketoacidosis', pph: 'postpartum haemorrhage',
  aml: 'myeloid leukemia', cml: 'myeloid leukemia', cll: 'lymphocytic leukemia',
  sah: 'subarachnoid', mcq: '', mcqs: '', pyq: '', pyqs: '',
};
// Two-letter terms worth searching for (most two-letter words are noise).
const SHORT_TERMS = new Set(['iv', 'im', 'hb', 'ct', 'mr', 'ms', 'ra', 'gh', 'pr', 'qt', 'st', 'pt', 'ph', 'k', 'na', 'ca', 'fe', 'cu', 'zn', 'ig', 'tb', 'hiv']);

/** Meaningful words of a free-text query, for a full-text search. */
export function searchTerms(text) {
  const words = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .flatMap((w) => (w in SHORTHAND ? SHORTHAND[w].split(' ').filter(Boolean) : [w]))
    .filter((w) => (w.length > 2 || SHORT_TERMS.has(w)) && !STOPWORDS.has(w));
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
                        'MaxWords=35, MinWords=15, StartSel="", StopSel="", MaxFragments=2, FragmentDelimiter=" … "') AS snippet,
            ts_rank_cd(n.search, to_tsquery('english', $1), 1|32) AS rank
     FROM notes n LEFT JOIN sources s ON s.id = n.source_id
     WHERE n.search @@ to_tsquery('english', $1) ${subject ? 'AND n.subject = $3' : ''}
     ORDER BY rank DESC LIMIT $2`,
    params
  );
}

async function searchQuestionsTs(tq, { limit = 50 } = {}) {
  return q(
    `SELECT q.id, q.subject, q.topic, q.stem, q.origin, q.year, q.page, s.filename,
            ts_rank_cd(q.search, to_tsquery('english', $1), 1|32) AS rank
     FROM questions q LEFT JOIN sources s ON s.id = q.source_id
     WHERE q.search @@ to_tsquery('english', $1)
     ORDER BY rank DESC LIMIT $2`,
    [tq, limit]
  );
}

// ---------- image questions ----------

export async function addImageQuestion({ subject, topic, answer, image, mime, sourceId }) {
  const rows = await q(
    `INSERT INTO questions (subject, topic, stem, options, answer, origin, source_id, hash, image, image_mime)
     VALUES ($1, $2, 'Identify this image', $3, 0, 'image', $4, $5, $6, $7)
     ON CONFLICT (hash) DO NOTHING RETURNING id`,
    [subject, topic || 'General', JSON.stringify([answer]), sourceId ?? null, createHash('sha1').update(image).digest('hex'), image, mime]
  );
  return rows.length > 0;
}

export async function pickImageQuestion(phone, subject = null) {
  return one(
    `SELECT q.id, q.subject, q.topic, q.options->>0 AS answer, q.image, q.image_mime,
            (SELECT MAX(a.created_at) FROM attempts a WHERE a.phone = $1 AND a.question_id = q.id) AS last_seen
     FROM questions q WHERE q.origin = 'image' AND ($2::text IS NULL OR q.subject = $2)
     ORDER BY last_seen NULLS FIRST, random() LIMIT 1`,
    [phone, subject]
  );
}

/** Other image answers to use as wrong options: same subject first. */
export async function imageDistractors(id, subject, answer, n = 3) {
  const rows = await q(
    `SELECT DISTINCT options->>0 AS answer, (subject = $2) AS same FROM questions
     WHERE origin = 'image' AND id <> $1 AND lower(options->>0) <> lower($3)
     ORDER BY same DESC LIMIT 30`,
    [id, subject, answer]
  );
  const same = rows.filter((r) => r.same).map((r) => r.answer);
  const other = rows.filter((r) => !r.same).map((r) => r.answer);
  return [...shuffle(same), ...shuffle(other)].filter((v, i, a) => a.indexOf(v) === i).slice(0, n);
}

// ---------- notes for flashcards ----------

export async function pickNote({ subject = null, topic = null } = {}) {
  if (topic) {
    const hits = await searchNotes(topic, { limit: 5, subject });
    if (hits.length) return hits[Math.floor(Math.random() * hits.length)];
  }
  return one(
    `SELECT n.id, n.subject, n.topic, n.content, n.page, s.filename FROM notes n LEFT JOIN sources s ON s.id = n.source_id
     WHERE ($1::text IS NULL OR n.subject = $1) AND length(n.content) > 80 ORDER BY random() LIMIT 1`,
    [subject]
  );
}

// ---------- similar questions / high-yield ----------

export async function similarQuestions(question, limit = 5) {
  const hits = await searchQuestionsTs(
    searchTerms(`${question.stem} ${question.options[question.answer] || ''}`).join(' | ') || 'zzzz',
    { limit: limit + 1 }
  );
  return hits.filter((h) => h.id !== question.id && h.origin !== 'image').slice(0, limit);
}

export async function highYield(phone, subject = null) {
  const pyq = await q(
    `SELECT q.subject, q.topic, COUNT(*)::int AS n, COUNT(DISTINCT NULLIF(q.year, ''))::int AS years,
            string_agg(DISTINCT NULLIF(q.year, ''), ', ' ORDER BY NULLIF(q.year, '')) AS year_list
     FROM questions q WHERE q.origin = 'pyq' AND ($1::text IS NULL OR q.subject = $1)
     GROUP BY q.subject, q.topic ORDER BY years DESC, n DESC LIMIT 12`,
    [subject]
  );
  const rows = pyq.length
    ? pyq
    : await q(
        `SELECT subject, topic, COUNT(*)::int AS n, 0 AS years, NULL AS year_list FROM questions
         WHERE origin <> 'image' AND ($1::text IS NULL OR subject = $1) GROUP BY subject, topic ORDER BY n DESC LIMIT 12`,
        [subject]
      );
  const acc = await q(
    `SELECT q.subject, q.topic, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE a.correct)::int AS c
     FROM attempts a JOIN questions q ON q.id = a.question_id WHERE a.phone = $1 GROUP BY q.subject, q.topic`,
    [phone]
  );
  const accMap = Object.fromEntries(acc.map((r) => [`${r.subject}|${r.topic}`, r]));
  return { fromPyq: pyq.length > 0, rows: rows.map((r) => ({ ...r, mine: accMap[`${r.subject}|${r.topic}`] || null })) };
}

export async function subjectAccuracy(phone) {
  const rows = await q(
    `SELECT q.subject, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE a.correct)::int AS c
     FROM attempts a JOIN questions q ON q.id = a.question_id WHERE a.phone = $1 GROUP BY q.subject`,
    [phone]
  );
  return Object.fromEntries(rows.map((r) => [r.subject, r]));
}

// ---------- buddies / leaderboard ----------

export function buddyCode(phone) {
  return createHash('sha1').update('buddy:' + phone).digest('hex').slice(0, 6).toUpperCase();
}

export async function findUserByCode(code) {
  const users = await q('SELECT phone, name, buddy_group FROM users');
  return users.find((u) => buddyCode(u.phone) === code.toUpperCase()) || null;
}

export const groupMembers = (groupId) => q('SELECT phone, name FROM users WHERE buddy_group = $1 ORDER BY phone', [groupId]);

export async function groupDailyQuestion(groupId, day, pick) {
  const existing = await one('SELECT question_id FROM group_daily WHERE group_id = $1 AND day = $2', [groupId, day]);
  if (existing) return existing.question_id;
  const id = await pick();
  if (!id) return null;
  await q('INSERT INTO group_daily (group_id, day, question_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [groupId, day, id]);
  return (await one('SELECT question_id FROM group_daily WHERE group_id = $1 AND day = $2', [groupId, day])).question_id;
}

/** Correct answers, attempts, active days in the last 7 days and current streak, per phone. */
export async function weekBoard(phones) {
  const rows = await q(
    `SELECT phone, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE correct)::int AS c,
            COUNT(DISTINCT (created_at AT TIME ZONE $2)::date)::int AS days
     FROM attempts WHERE phone = ANY($1::text[]) AND created_at >= now() - interval '7 days' GROUP BY phone`,
    [phones, config.timezone]
  );
  const out = Object.fromEntries(phones.map((p) => [p, { n: 0, c: 0, days: 0, streak: 0 }]));
  for (const r of rows) Object.assign(out[r.phone], r);
  for (const p of phones) out[p].streak = await streak(p);
  return out;
}

/** Consecutive days (ending today or yesterday) with at least one answer. */
export async function streak(phone) {
  const rows = await q(
    `SELECT DISTINCT to_char((created_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS d FROM attempts
     WHERE phone = $1 AND created_at >= now() - interval '400 days' ORDER BY d DESC`,
    [phone, config.timezone]
  );
  const days = new Set(rows.map((r) => r.d));
  let day = localNow().date;
  if (!days.has(day)) day = addDays(day, -1);
  let n = 0;
  while (days.has(day)) { n++; day = addDays(day, -1); }
  return n;
}

export async function weekSummary(phone) {
  const r = await one(
    `SELECT COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS n,
            COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days' AND correct)::int AS c,
            COUNT(*) FILTER (WHERE created_at < now() - interval '7 days')::int AS pn,
            COUNT(*) FILTER (WHERE created_at < now() - interval '7 days' AND correct)::int AS pc
     FROM attempts WHERE phone = $1 AND created_at >= now() - interval '14 days'`,
    [phone]
  );
  return r;
}
