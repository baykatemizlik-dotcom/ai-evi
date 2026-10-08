-- v0.5 only: Cloudflare D1, execute once in a dedicated test database.
CREATE TABLE IF NOT EXISTS test_budget (
 id INTEGER PRIMARY KEY CHECK(id=1),
 limit_cents INTEGER NOT NULL DEFAULT 200,
 reserved_cents INTEGER NOT NULL DEFAULT 0,
 CHECK(reserved_cents>=0 AND reserved_cents<=limit_cents)
);
INSERT OR IGNORE INTO test_budget(id,limit_cents,reserved_cents) VALUES(1,200,0);
CREATE TABLE IF NOT EXISTS conversations (
 id TEXT PRIMARY KEY,
 question TEXT NOT NULL,
 stage TEXT NOT NULL DEFAULT 'GPT_DRAFT',
 status TEXT NOT NULL DEFAULT 'READY',
 gpt_draft TEXT, gemini_review TEXT, gpt_revision TEXT, gemini_final TEXT,
 result TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 last_error TEXT,
 reserved_cents INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
