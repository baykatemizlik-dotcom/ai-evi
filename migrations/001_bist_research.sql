-- BIST AVCI research cache and atomic five-slot daily quota
-- Run as a reviewed D1 migration BEFORE deploying the new Worker.
-- No customer records are deleted.
CREATE TABLE IF NOT EXISTS bist_research_cache (
 day TEXT NOT NULL,
 symbol TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('RESERVED','DONE','FAILED')),
 response_json TEXT,
 created_at TEXT NOT NULL,
 PRIMARY KEY(day,symbol)
);
CREATE INDEX IF NOT EXISTS idx_bist_research_day_status
 ON bist_research_cache(day,status);
