-- Additive only: no changes to any existing motor/table/trigger/account.
CREATE TABLE IF NOT EXISTS research_paper_trials(
 id TEXT PRIMARY KEY CHECK(id IN('DENEME_1','DENEME_2')),
 revision INTEGER NOT NULL DEFAULT 0,
 state_json TEXT NOT NULL CHECK(json_valid(state_json)),
 updated_at TEXT NOT NULL
);
