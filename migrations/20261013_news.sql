CREATE TABLE IF NOT EXISTS news_sources (
  source_id TEXT PRIMARY KEY, source_url TEXT NOT NULL, status TEXT NOT NULL,
  last_attempt_at TEXT, last_success_at TEXT, checkpoint_at TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS news_runs (
  run_id TEXT PRIMARY KEY, wave TEXT NOT NULL, started_at TEXT NOT NULL,
  finished_at TEXT, status TEXT NOT NULL, metrics_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS news_records (
  record_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_record_id TEXT NOT NULL,
  record_version INTEGER NOT NULL, supersedes_record_id TEXT, content_hash TEXT NOT NULL,
  published_at TEXT NOT NULL, fetched_at TEXT NOT NULL,
  source_url TEXT NOT NULL, headline TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'RAW',
  UNIQUE(source_id,source_record_id,content_hash)
);
CREATE INDEX IF NOT EXISTS news_records_identity ON news_records(source_id,source_record_id,record_version);
CREATE INDEX IF NOT EXISTS news_records_state ON news_records(state,published_at,record_id);
CREATE TABLE IF NOT EXISTS news_bodies (
  record_id TEXT PRIMARY KEY REFERENCES news_records(record_id), raw_json TEXT NOT NULL,
  payload_json TEXT, payload_hash TEXT, analyzed_at TEXT
);
CREATE TABLE IF NOT EXISTS news_receipts (
  record_id TEXT PRIMARY KEY REFERENCES news_records(record_id), payload_hash TEXT NOT NULL,
  acked_at TEXT NOT NULL, client_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS news_followups (
  record_id TEXT PRIMARY KEY REFERENCES news_records(record_id), importance INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'WAITING_RESEARCH', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS news_followups_pending ON news_followups(status,importance,created_at);
