-- v0.5 only: Cloudflare D1, execute once in a dedicated test database.
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
