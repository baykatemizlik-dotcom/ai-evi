-- Apply once to the existing ai-evi schema. Never resets balances or trades.
ALTER TABLE virtual_trades ADD COLUMN feed_entry_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS cloud_trade_entry_key ON virtual_trades(feed_entry_key);
CREATE TABLE IF NOT EXISTS bist_feed_signals (
 signal_key TEXT PRIMARY KEY, symbol TEXT NOT NULL, bar_time TEXT NOT NULL,
 observed_at TEXT NOT NULL, expires_at TEXT NOT NULL, source TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ENTERED','EXPIRED')),
 metrics_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bist_feed_state (
 symbol TEXT PRIMARY KEY, last_bar_time TEXT NOT NULL, source TEXT NOT NULL,
 feed_type TEXT NOT NULL, received_at TEXT NOT NULL
);
INSERT OR IGNORE INTO paper_cash_accounts(strategy,initial_cash,available_cash,updated_at)
 VALUES('SCALP',2500,2500,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TRIGGER IF NOT EXISTS cloud_paper_entry_guard
BEFORE INSERT ON virtual_trades WHEN NEW.feed_entry_key IS NOT NULL
BEGIN
 SELECT (CASE WHEN NEW.strategy!='SCALP' OR NEW.status!='OPEN' OR NEW.slot_id NOT IN (1,2)
  THEN RAISE(ABORT,'PAPER_INVALID_ENTRY') END);
 SELECT (CASE WHEN (SELECT COUNT(*) FROM virtual_trades WHERE strategy='SCALP' AND status='OPEN')>=2
  OR EXISTS(SELECT 1 FROM virtual_trades WHERE strategy='SCALP' AND status='OPEN'
   AND (slot_id=NEW.slot_id OR symbol=NEW.symbol)) THEN RAISE(ABORT,'PAPER_SLOT_BUSY') END);
 SELECT (CASE WHEN NEW.executed_price*NEW.lot_count+NEW.commission>1250.000001
  OR NOT EXISTS(SELECT 1 FROM paper_cash_accounts WHERE strategy='SCALP'
   AND available_cash>=NEW.executed_price*NEW.lot_count+NEW.commission)
  THEN RAISE(ABORT,'PAPER_INSUFFICIENT_CASH') END);
 SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM bist_feed_signals WHERE signal_key=NEW.feed_entry_key
  AND status='PENDING' AND observed_at<=NEW.entry_time AND expires_at>=NEW.entry_time)
  THEN RAISE(ABORT,'PAPER_SIGNAL_NOT_ELIGIBLE') END);
END;
CREATE TRIGGER IF NOT EXISTS cloud_paper_entry_cash
AFTER INSERT ON virtual_trades WHEN NEW.feed_entry_key IS NOT NULL
BEGIN
 UPDATE paper_cash_accounts SET available_cash=available_cash-NEW.executed_price*NEW.lot_count-NEW.commission,
  updated_at=NEW.entry_time WHERE strategy='SCALP';
 UPDATE bist_feed_signals SET status='ENTERED' WHERE signal_key=NEW.feed_entry_key;
END;
CREATE TRIGGER IF NOT EXISTS cloud_paper_exit_guard
BEFORE UPDATE OF status ON virtual_trades
WHEN OLD.feed_entry_key IS NOT NULL AND OLD.status='OPEN' AND NEW.status='CLOSED'
BEGIN
 SELECT (CASE WHEN NEW.exit_price IS NULL OR NEW.exit_time IS NULL OR NEW.pnl_net IS NULL
  OR abs(NEW.pnl_net-(NEW.exit_price*NEW.lot_count*0.998-
    (OLD.executed_price*OLD.lot_count+OLD.commission)))>0.00001
  THEN RAISE(ABORT,'PAPER_INVALID_EXIT') END);
END;
CREATE TRIGGER IF NOT EXISTS cloud_paper_exit_cash
AFTER UPDATE OF status ON virtual_trades
WHEN OLD.feed_entry_key IS NOT NULL AND OLD.status='OPEN' AND NEW.status='CLOSED'
BEGIN
 UPDATE paper_cash_accounts SET available_cash=available_cash+NEW.exit_price*NEW.lot_count*0.998,
  updated_at=NEW.exit_time WHERE strategy='SCALP';
END;
