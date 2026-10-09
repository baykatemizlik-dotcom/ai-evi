-- Additive decision cache; never reset bars, trades or cash.
CREATE TABLE IF NOT EXISTS bist_ai_decisions (
 signal_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, symbol TEXT NOT NULL,
 bar_time TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL
 CHECK(status IN('PENDING','APPROVED','REJECTED','ERROR')),
 reason TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT,
 input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0
);
