-- AI Evi kalıcı karar defteri (v0.5).
-- Google Docs bağımlılığı YOK. Var olan v05/schema.sql ardından uygulanır.
CREATE TABLE IF NOT EXISTS decisions (
 id TEXT PRIMARY KEY,
 project TEXT NOT NULL DEFAULT 'genel',
 title TEXT NOT NULL,
 body TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded')),
 supersedes_id TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(supersedes_id) REFERENCES decisions(id)
);
CREATE INDEX IF NOT EXISTS decisions_project_active ON decisions(project,status,updated_at);
CREATE TABLE IF NOT EXISTS conversation_events (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL,
 stage TEXT NOT NULL,
 content TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);
CREATE INDEX IF NOT EXISTS events_conversation ON conversation_events(conversation_id,created_at);
