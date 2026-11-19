PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  subscribed INTEGER NOT NULL DEFAULT 1 CHECK (subscribed IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  note TEXT NOT NULL DEFAULT '',
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  email_sent_at TEXT
);

CREATE TABLE IF NOT EXISTS admins (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lessons (
  date TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  error_code TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE(date, user_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  status TEXT NOT NULL,
  counts_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS digest_locks (
  date TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('processing', 'sent', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_deliveries_user_date ON deliveries(user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_deliveries_date ON deliveries(date DESC);
CREATE INDEX IF NOT EXISTS idx_runs_date ON runs(date DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('timezone', 'UTC', datetime('now')),
  ('send_time', '06:00', datetime('now')),
  ('summary_language', 'Korean', datetime('now')),
  ('llm_base_url', '', datetime('now')),
  ('llm_model', '', datetime('now')),
  ('last_cleanup_date', '0000-00-00', datetime('now'));

INSERT OR IGNORE INTO sources (id, name, url, enabled, sort_order, created_at, updated_at) VALUES
  ('bbc', 'BBC World', 'https://feeds.bbci.co.uk/news/world/rss.xml', 1, 0, datetime('now'), datetime('now')),
  ('guardian', 'The Guardian', 'https://www.theguardian.com/world/rss', 1, 1, datetime('now'), datetime('now')),
  ('cnn', 'CNN Top Stories', 'http://rss.cnn.com/rss/edition.rss', 1, 2, datetime('now'), datetime('now')),
  ('ap', 'AP Top News', 'https://apnews.com/hub/ap-top-news?output=rss', 1, 3, datetime('now'), datetime('now')),
  ('lemonde', 'Le Monde', 'https://www.lemonde.fr/rss/une.xml', 1, 4, datetime('now'), datetime('now')),
  ('brusselstimes', 'The Brussels Times', 'https://www.brusselstimes.com/feed', 1, 5, datetime('now'), datetime('now'));