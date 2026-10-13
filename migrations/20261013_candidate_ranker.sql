-- Isolated bounded candidate ranking; no cash/trade/price schema changes.
CREATE TABLE IF NOT EXISTS news_rank_control(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 1,reason TEXT NOT NULL DEFAULT 'USER_ENABLED',updated_at TEXT NOT NULL);
INSERT OR IGNORE INTO news_rank_control VALUES(1,1,'USER_ENABLED',strftime('%Y-%m-%dT%H:%M:%SZ','now'));
CREATE TABLE IF NOT EXISTS news_rank_budget(day TEXT PRIMARY KEY,spent_micro_usd INTEGER NOT NULL DEFAULT 0,reserved_micro_usd INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS news_rank_runs(run_id TEXT PRIMARY KEY,day TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,reserved_micro_usd INTEGER NOT NULL,result_json TEXT,error TEXT);
CREATE TABLE IF NOT EXISTS news_rank_choices(signal_key TEXT PRIMARY KEY,run_id TEXT NOT NULL,symbol TEXT NOT NULL,rank INTEGER NOT NULL,role TEXT NOT NULL CHECK(role IN('PRIMARY','BACKUP','WATCH')),confidence INTEGER NOT NULL,reason TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS news_official_flags(record_id TEXT PRIMARY KEY,symbol TEXT NOT NULL,action_flag TEXT NOT NULL CHECK(action_flag='BLACKLIST'),valid_from TEXT NOT NULL,valid_until TEXT NOT NULL,reason TEXT NOT NULL,source_url TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS news_official_flags_symbol ON news_official_flags(symbol,valid_from,valid_until);
