CREATE TABLE IF NOT EXISTS bist_external_audits (
 trt_date TEXT PRIMARY KEY, received_at TEXT NOT NULL, model TEXT NOT NULL,
 status TEXT NOT NULL, report_json TEXT NOT NULL
);
