-- Additive only: no deletion or balance reset.
CREATE TABLE IF NOT EXISTS bist_funnel_risk (
 symbol TEXT PRIMARY KEY, eligible INTEGER NOT NULL CHECK(eligible IN(0,1)),
 as_of TEXT NOT NULL, valid_until TEXT NOT NULL, source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bist_funnel_candidates (
 run_id TEXT NOT NULL, symbol TEXT NOT NULL, bar_time TEXT NOT NULL,
 observed_at TEXT NOT NULL, score REAL NOT NULL, metrics_json TEXT NOT NULL,
 PRIMARY KEY(run_id,symbol,bar_time)
);
CREATE TABLE IF NOT EXISTS bist_funnel_reports (
 run_id TEXT NOT NULL, shard INTEGER NOT NULL, universe_total INTEGER NOT NULL,
 eligible_total INTEGER NOT NULL, assigned INTEGER NOT NULL, fetched INTEGER NOT NULL,
 hot INTEGER NOT NULL, posted INTEGER NOT NULL, errors INTEGER NOT NULL,
 last_bar_time TEXT, completed_at TEXT NOT NULL, PRIMARY KEY(run_id,shard)
);
