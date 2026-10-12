CREATE TABLE IF NOT EXISTS news_event_records (
 record_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, source_record_id TEXT NOT NULL,
 event_type TEXT NOT NULL, symbol TEXT NOT NULL, headline TEXT NOT NULL,
 published_at TEXT NOT NULL, fetched_at TEXT NOT NULL, raw_json TEXT,
 state TEXT NOT NULL DEFAULT 'CLOUD', CHECK(event_type IN ('FORMATION','DETECTOR','TREND'))
);
CREATE INDEX IF NOT EXISTS news_events_time ON news_event_records(published_at,record_id);
