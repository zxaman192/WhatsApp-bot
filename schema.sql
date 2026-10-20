-- Database schema. The bot also creates this itself on startup (src/db.js); keep the two in sync.
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
