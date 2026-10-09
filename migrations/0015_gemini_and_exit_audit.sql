-- Additive only: preserve cash, bars, approvals and all paper trades.
CREATE TABLE IF NOT EXISTS bist_gemini_decisions (
 signal_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, symbol TEXT NOT NULL,
 bar_time TEXT NOT NULL, model TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('APPROVED','REJECTED','ERROR')),
 confidence INTEGER NOT NULL DEFAULT 0 CHECK(confidence BETWEEN 0 AND 100),
 reason TEXT NOT NULL, completed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bist_exit_audit (
 trade_id INTEGER PRIMARY KEY REFERENCES virtual_trades(id),
 exit_bar_time TEXT, exit_observed_at TEXT NOT NULL, exit_reason TEXT NOT NULL
);
-- Retain history, but remove old pending entries/standbys that have never passed 40M validation.
UPDATE bist_sniper_queue SET status='INVALID',reason='40M_TURNOVER_REVALIDATION_REQUIRED'
 WHERE status='READY' AND COALESCE(json_extract(metrics_json,'$.daily_turnover_tl_estimate'),0)<40000000;
UPDATE bist_feed_signals SET status='EXPIRED'
 WHERE status='PENDING' AND COALESCE(json_extract(metrics_json,'$.daily_turnover_tl_estimate'),0)<40000000;
