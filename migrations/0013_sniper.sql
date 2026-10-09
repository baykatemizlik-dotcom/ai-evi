-- Additive state and guarded trigger replacement; preserves every trade and cash balance.
ALTER TABLE bist_ai_decisions ADD COLUMN confidence INTEGER;
ALTER TABLE bist_ai_decisions ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS bist_sniper_queue (
 signal_key TEXT PRIMARY KEY, symbol TEXT NOT NULL, bar_time TEXT NOT NULL,
 observed_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_checked_bar TEXT NOT NULL,
 last_checked_at TEXT NOT NULL, score REAL NOT NULL, confidence INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN('READY','OPEN','INVALID','EXPIRED','USED')),
 reason TEXT NOT NULL, metrics_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bist_sniper_state (
 trade_id INTEGER PRIMARY KEY, peak_price REAL NOT NULL, stop_price REAL NOT NULL,
 last_peak_at TEXT NOT NULL, last_processed_bar TEXT, breakeven INTEGER NOT NULL DEFAULT 0,
 quote_time TEXT, last_exit_note TEXT, exit_observed_at TEXT
);
CREATE TABLE IF NOT EXISTS bist_session_lock (
 trt_date TEXT PRIMARY KEY, locked_at TEXT NOT NULL
);
DROP TRIGGER IF EXISTS cloud_paper_entry_guard;
DROP TRIGGER IF EXISTS cloud_paper_entry_cash;
DROP TRIGGER IF EXISTS cloud_paper_exit_cash;
CREATE TRIGGER cloud_paper_entry_guard
BEFORE INSERT ON virtual_trades WHEN NEW.feed_entry_key IS NOT NULL
BEGIN
 SELECT (CASE WHEN NEW.strategy NOT IN('SCALP','SWING') OR NEW.status!='OPEN'
  OR (NEW.strategy='SCALP' AND NEW.slot_id NOT IN(1,2))
  OR (NEW.strategy='SWING' AND (NEW.slot_id!=1 OR NEW.feed_entry_key NOT LIKE 'SNIPER:%'))
  THEN RAISE(ABORT,'PAPER_INVALID_ENTRY') END);
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM virtual_trades WHERE status='OPEN' AND symbol=NEW.symbol)
  OR (SELECT COUNT(*) FROM virtual_trades WHERE strategy=NEW.strategy AND status='OPEN')>=
   (CASE WHEN NEW.strategy='SCALP' THEN 2 ELSE 1 END)
  OR EXISTS(SELECT 1 FROM virtual_trades WHERE strategy=NEW.strategy AND status='OPEN' AND slot_id=NEW.slot_id)
  THEN RAISE(ABORT,'PAPER_SLOT_BUSY') END);
 SELECT (CASE WHEN (NEW.strategy='SCALP' AND NEW.executed_price*NEW.lot_count+NEW.commission>1250.000001)
  OR NOT EXISTS(SELECT 1 FROM paper_cash_accounts WHERE strategy=NEW.strategy AND available_cash>=NEW.executed_price*NEW.lot_count+NEW.commission)
  THEN RAISE(ABORT,'PAPER_INSUFFICIENT_CASH') END);
 SELECT (CASE WHEN (NEW.strategy='SCALP' AND NOT EXISTS(SELECT 1 FROM bist_feed_signals WHERE signal_key=NEW.feed_entry_key AND status='PENDING' AND observed_at<=NEW.entry_time AND expires_at>=NEW.entry_time))
  OR (NEW.strategy='SWING' AND NOT EXISTS(SELECT 1 FROM bist_sniper_queue WHERE 'SNIPER:'||signal_key=NEW.feed_entry_key AND status='READY' AND observed_at<=NEW.entry_time AND expires_at>=NEW.entry_time))
  THEN RAISE(ABORT,'PAPER_SIGNAL_NOT_ELIGIBLE') END);
END;
CREATE TRIGGER cloud_paper_entry_cash
AFTER INSERT ON virtual_trades WHEN NEW.feed_entry_key IS NOT NULL
BEGIN
 UPDATE paper_cash_accounts SET available_cash=available_cash-NEW.executed_price*NEW.lot_count-NEW.commission,
  updated_at=NEW.entry_time WHERE strategy=NEW.strategy;
 UPDATE bist_feed_signals SET status='ENTERED' WHERE signal_key=NEW.feed_entry_key AND NEW.strategy='SCALP';
 UPDATE bist_sniper_queue SET status='OPEN',reason='SNIPER_POSITION_OPEN' WHERE 'SNIPER:'||signal_key=NEW.feed_entry_key AND NEW.strategy='SWING';
END;
CREATE TRIGGER cloud_paper_exit_cash
AFTER UPDATE OF status ON virtual_trades
WHEN OLD.feed_entry_key IS NOT NULL AND OLD.status='OPEN' AND NEW.status='CLOSED'
BEGIN
 UPDATE paper_cash_accounts SET available_cash=available_cash+NEW.exit_price*NEW.lot_count*0.998,
  updated_at=NEW.exit_time WHERE strategy=NEW.strategy;
 UPDATE bist_sniper_queue SET status='USED',reason=NEW.exit_reason WHERE 'SNIPER:'||signal_key=NEW.feed_entry_key AND NEW.strategy='SWING';
END;
CREATE TABLE IF NOT EXISTS bist_daily_reports (
 trt_date TEXT PRIMARY KEY, generated_at TEXT NOT NULL, report_json TEXT NOT NULL
);
