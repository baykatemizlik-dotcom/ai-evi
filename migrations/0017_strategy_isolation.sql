-- Apply once, after 0016. No balance reset and no deletion of historic trades.
ALTER TABLE virtual_trades ADD COLUMN engine_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE virtual_trades ADD COLUMN remaining_lots INTEGER;
ALTER TABLE virtual_trades ADD COLUMN tp1_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE virtual_trades ADD COLUMN trailing_stop REAL;
ALTER TABLE virtual_trades ADD COLUMN last_processed_trend_bar TEXT;
ALTER TABLE virtual_trades ADD COLUMN entry_quote_time TEXT;
ALTER TABLE virtual_trades ADD COLUMN entry_observed_at TEXT;
CREATE TABLE scalp_sniper_queue(signal_key TEXT PRIMARY KEY,symbol TEXT NOT NULL,bar_time TEXT NOT NULL,observed_at TEXT NOT NULL,expires_at TEXT NOT NULL,score REAL NOT NULL,status TEXT NOT NULL CHECK(status IN('READY','ENTERED','EXPIRED','INVALID')),reason TEXT NOT NULL,metrics_json TEXT NOT NULL);
CREATE TABLE trend_radar_queue(signal_key TEXT PRIMARY KEY,symbol TEXT NOT NULL,bar_time TEXT NOT NULL,observed_at TEXT NOT NULL,expires_at TEXT NOT NULL,score REAL NOT NULL,priority INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL CHECK(status IN('READY','ENTERED','EXPIRED','INVALID')),reason TEXT NOT NULL,metrics_json TEXT NOT NULL);
CREATE INDEX scalp_ready ON scalp_sniper_queue(status,expires_at,score);
CREATE INDEX trend_ready ON trend_radar_queue(status,expires_at,priority,score);
CREATE TABLE strategy_quotes(symbol TEXT PRIMARY KEY,price REAL NOT NULL CHECK(price>0),quote_time TEXT NOT NULL,received_at TEXT NOT NULL,source TEXT NOT NULL CHECK(source='YAHOO_INDICATIVE'));
CREATE TABLE trend_bars(symbol TEXT NOT NULL,interval TEXT NOT NULL CHECK(interval IN('60m','1d')),bar_time TEXT NOT NULL,open REAL NOT NULL,high REAL NOT NULL,low REAL NOT NULL,close REAL NOT NULL,volume REAL NOT NULL,source TEXT NOT NULL,received_at TEXT NOT NULL,PRIMARY KEY(symbol,interval,bar_time));
CREATE TABLE berker3_symbols(symbol TEXT PRIMARY KEY,priority INTEGER NOT NULL DEFAULT 1,active INTEGER NOT NULL DEFAULT 1);
INSERT INTO berker3_symbols(symbol) VALUES('BORLS'),('REEDR'),('BINHO'),('ASTOR');
CREATE TABLE strategy_exit_legs(event_key TEXT PRIMARY KEY,trade_id INTEGER NOT NULL REFERENCES virtual_trades(id),strategy TEXT NOT NULL CHECK(strategy IN('SCALP','SWING')),symbol TEXT NOT NULL,qty INTEGER NOT NULL CHECK(qty>0),executed_price REAL NOT NULL CHECK(executed_price>0),commission REAL NOT NULL CHECK(commission>=0),exit_time TEXT NOT NULL,quote_time TEXT NOT NULL,observed_at TEXT NOT NULL,reason TEXT NOT NULL,pnl_net REAL NOT NULL);
CREATE INDEX strategy_exit_history ON strategy_exit_legs(exit_time,strategy);
-- Preserve live positions and their original fee/lot basis. Retire the old single-slot engine.
UPDATE virtual_trades SET remaining_lots=CASE WHEN status='OPEN' THEN lot_count ELSE 0 END;
UPDATE virtual_trades SET engine_version=2,entry_observed_at=COALESCE((SELECT created_at FROM bist_push_events WHERE id='entry:'||virtual_trades.id),entry_time),entry_quote_time=entry_time,trailing_stop=CASE WHEN strategy='SWING' THEN executed_price*0.98 ELSE NULL END WHERE status='OPEN';
UPDATE bist_sniper_queue SET status='EXPIRED',reason='RETIRED_SINGLE_SLOT_ENGINE' WHERE status='READY';
UPDATE bist_feed_signals SET status='EXPIRED' WHERE status='PENDING';
DROP TRIGGER IF EXISTS cloud_paper_entry_guard;
DROP TRIGGER IF EXISTS cloud_paper_entry_cash;
DROP TRIGGER IF EXISTS cloud_paper_exit_cash;
DROP TRIGGER IF EXISTS cloud_paper_exit_guard;
CREATE TRIGGER cloud_paper_entry_guard BEFORE INSERT ON virtual_trades WHEN NEW.engine_version=2 OR NEW.feed_entry_key IS NOT NULL BEGIN
 SELECT CASE WHEN NEW.engine_version!=2 OR NEW.strategy NOT IN('SCALP','SWING') OR NEW.status!='OPEN' OR NEW.slot_id NOT IN(1,2) OR COALESCE(NEW.remaining_lots,0)!=NEW.lot_count OR NEW.lot_count<CASE WHEN NEW.strategy='SWING' THEN 2 ELSE 1 END OR NEW.entry_observed_at IS NULL OR NEW.entry_quote_time IS NULL THEN RAISE(ABORT,'PAPER_INVALID_ENTRY') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM virtual_trades WHERE strategy=NEW.strategy AND status='OPEN' AND (slot_id=NEW.slot_id OR symbol=NEW.symbol)) OR (SELECT COUNT(*) FROM virtual_trades WHERE strategy=NEW.strategy AND status='OPEN')>=2 THEN RAISE(ABORT,'PAPER_SLOT_BUSY') END;
 SELECT CASE WHEN NEW.executed_price*NEW.lot_count+NEW.commission>1250.000001 OR NOT EXISTS(SELECT 1 FROM paper_cash_accounts WHERE strategy=NEW.strategy AND available_cash>=NEW.executed_price*NEW.lot_count+NEW.commission) THEN RAISE(ABORT,'PAPER_INSUFFICIENT_CASH') END;
 SELECT CASE WHEN (NEW.strategy='SCALP' AND NOT EXISTS(SELECT 1 FROM scalp_sniper_queue WHERE 'SCALP:'||signal_key=NEW.feed_entry_key AND status='READY' AND observed_at<=NEW.entry_time AND expires_at>NEW.entry_time)) OR (NEW.strategy='SWING' AND NOT EXISTS(SELECT 1 FROM trend_radar_queue WHERE 'TREND:'||signal_key=NEW.feed_entry_key AND status='READY' AND observed_at<=NEW.entry_time AND expires_at>NEW.entry_time)) THEN RAISE(ABORT,'PAPER_SIGNAL_NOT_ELIGIBLE') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM bist_funnel_risk WHERE symbol=NEW.symbol AND eligible=1 AND valid_until>NEW.entry_time) OR NOT EXISTS(SELECT 1 FROM strategy_quotes WHERE symbol=NEW.symbol AND quote_time=NEW.entry_quote_time AND julianday(quote_time)<=julianday(NEW.entry_time) AND julianday(quote_time)>=julianday(NEW.entry_time)-15.0/1440 AND date(quote_time,'+3 hours')=date(NEW.entry_time,'+3 hours') AND ABS(price*1.002-NEW.executed_price)<0.000001) THEN RAISE(ABORT,'PAPER_QUOTE_OR_RISK_INVALID') END;
END;
CREATE TRIGGER cloud_paper_exit_guard BEFORE UPDATE OF status ON virtual_trades WHEN OLD.status='OPEN' AND NEW.status='CLOSED' BEGIN
 SELECT CASE WHEN NEW.engine_version!=2 OR NEW.remaining_lots!=0 OR NEW.pnl_net IS NULL OR ABS(NEW.pnl_net-COALESCE((SELECT SUM(pnl_net) FROM strategy_exit_legs WHERE trade_id=NEW.id),0))>0.000001 OR (SELECT COALESCE(SUM(qty),0) FROM strategy_exit_legs WHERE trade_id=NEW.id)!=NEW.lot_count THEN RAISE(ABORT,'INVALID_FINAL_ACCOUNTING') END;
END;
CREATE TRIGGER cloud_paper_entry_cash AFTER INSERT ON virtual_trades WHEN NEW.engine_version=2 BEGIN
 UPDATE paper_cash_accounts SET available_cash=available_cash-NEW.executed_price*NEW.lot_count-NEW.commission,updated_at=NEW.entry_time WHERE strategy=NEW.strategy;
 UPDATE scalp_sniper_queue SET status='ENTERED',reason='INSTANT_PAPER_ENTRY' WHERE 'SCALP:'||signal_key=NEW.feed_entry_key AND NEW.strategy='SCALP';
 UPDATE bist_feed_signals SET status='ENTERED' WHERE 'SCALP:'||signal_key=NEW.feed_entry_key AND NEW.strategy='SCALP';
 UPDATE trend_radar_queue SET status='ENTERED',reason='INSTANT_PAPER_ENTRY' WHERE 'TREND:'||signal_key=NEW.feed_entry_key AND NEW.strategy='SWING';
END;
CREATE TRIGGER strategy_leg_guard BEFORE INSERT ON strategy_exit_legs BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM virtual_trades WHERE id=NEW.trade_id AND engine_version=2 AND status='OPEN' AND strategy=NEW.strategy AND symbol=NEW.symbol AND remaining_lots>=NEW.qty) THEN RAISE(ABORT,'INVALID_EXIT_LEG') END;
 SELECT CASE WHEN NEW.reason='TREND_TP1' AND NOT EXISTS(SELECT 1 FROM virtual_trades WHERE id=NEW.trade_id AND strategy='SWING' AND tp1_done=0 AND NEW.qty=CAST(lot_count/2 AS INTEGER) AND remaining_lots=lot_count) THEN RAISE(ABORT,'INVALID_TP1') END;
 SELECT CASE WHEN NEW.reason!='TREND_TP1' AND NOT EXISTS(SELECT 1 FROM virtual_trades WHERE id=NEW.trade_id AND remaining_lots=NEW.qty) THEN RAISE(ABORT,'EXIT_MUST_CLOSE_REMAINDER') END;
 SELECT CASE WHEN ABS(NEW.commission-NEW.executed_price*NEW.qty*0.002)>0.000001 OR NOT EXISTS(SELECT 1 FROM virtual_trades WHERE id=NEW.trade_id AND ABS(NEW.pnl_net-(NEW.executed_price*NEW.qty-NEW.commission-(executed_price+commission/lot_count)*NEW.qty))<0.000001) THEN RAISE(ABORT,'INVALID_EXIT_ACCOUNTING') END;
END;
CREATE TRIGGER strategy_leg_cash AFTER INSERT ON strategy_exit_legs BEGIN
 UPDATE paper_cash_accounts SET available_cash=available_cash+NEW.executed_price*NEW.qty-NEW.commission,updated_at=NEW.observed_at WHERE strategy=NEW.strategy;
 UPDATE virtual_trades SET remaining_lots=remaining_lots-NEW.qty,tp1_done=CASE WHEN NEW.reason='TREND_TP1' THEN 1 ELSE tp1_done END,trailing_stop=CASE WHEN NEW.reason='TREND_TP1' THEN MAX(COALESCE(trailing_stop,0),(executed_price+commission/lot_count)/(0.998*0.998)) ELSE trailing_stop END WHERE id=NEW.trade_id;
 UPDATE virtual_trades SET status='CLOSED',exit_price=NEW.executed_price,exit_time=NEW.exit_time,exit_reason=NEW.reason,pnl_net=(SELECT SUM(pnl_net) FROM strategy_exit_legs WHERE trade_id=NEW.trade_id) WHERE id=NEW.trade_id AND remaining_lots=0;
END;
DROP TRIGGER IF EXISTS bist_push_exit;
DROP TRIGGER IF EXISTS bist_push_entry;
CREATE TRIGGER bist_push_entry AFTER INSERT ON virtual_trades WHEN NEW.engine_version=2 BEGIN
 INSERT OR IGNORE INTO bist_push_events VALUES('entry:'||NEW.id,json_object('title','BIST · AL gerçekleşti (sanal)','body',NEW.symbol||' · '||CASE WHEN NEW.strategy='SWING' THEN 'Trend' ELSE 'Scalp' END||' · '||NEW.lot_count||' lot','tag','entry:'||NEW.id),strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes'));
END;
CREATE TRIGGER strategy_leg_push AFTER INSERT ON strategy_exit_legs BEGIN
 INSERT OR IGNORE INTO bist_push_events VALUES('leg:'||NEW.event_key,json_object('title','BIST · SAT gerçekleşti (sanal)','body',NEW.symbol||' · '||NEW.qty||' lot · '||NEW.reason||' · Net '||round(NEW.pnl_net,2)||' TL','tag','leg:'||NEW.event_key),NEW.observed_at,strftime('%Y-%m-%dT%H:%M:%fZ',NEW.observed_at,'+10 minutes'));
END;
CREATE TRIGGER trend_candidate_push AFTER INSERT ON trend_radar_queue BEGIN
 INSERT OR IGNORE INTO bist_push_events VALUES('trend:'||NEW.signal_key,json_object('title','BIST · Yeni Trend AL sinyali','body',NEW.symbol||' · Trend radarında; slot bekliyor.','tag','trend:'||NEW.signal_key),NEW.observed_at,NEW.expires_at);
END;
