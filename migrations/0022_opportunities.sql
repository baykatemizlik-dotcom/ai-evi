-- Additive archive and observed quotes. Does not reset cash or trade history.
CREATE TABLE IF NOT EXISTS strategy_market_context(symbol TEXT PRIMARY KEY,session_date TEXT NOT NULL,previous_close REAL NOT NULL CHECK(previous_close>0),previous_bar_time TEXT NOT NULL,received_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS opportunity_events(event_key TEXT PRIMARY KEY,strategy TEXT NOT NULL CHECK(strategy IN('SCALP','SWING')),symbol TEXT NOT NULL,signal_key TEXT NOT NULL,stage TEXT NOT NULL,captured_at TEXT NOT NULL,bar_time TEXT NOT NULL,metrics_json TEXT NOT NULL,entry_quote_json TEXT,origin TEXT NOT NULL DEFAULT 'OBSERVED');
CREATE INDEX IF NOT EXISTS opportunity_day ON opportunity_events(captured_at,strategy,stage);
CREATE INDEX IF NOT EXISTS opportunity_signal ON opportunity_events(signal_key,strategy,captured_at);
CREATE TABLE IF NOT EXISTS opportunity_quotes(symbol TEXT NOT NULL,quote_time TEXT NOT NULL,received_at TEXT NOT NULL,price REAL NOT NULL,source TEXT NOT NULL,PRIMARY KEY(symbol,quote_time));
CREATE INDEX IF NOT EXISTS opportunity_quote_observed ON opportunity_quotes(symbol,received_at);
CREATE TABLE IF NOT EXISTS high_momentum_radar(signal_key TEXT PRIMARY KEY,symbol TEXT NOT NULL,daily_change_pct REAL NOT NULL,rvol REAL NOT NULL,reason TEXT NOT NULL,captured_at TEXT NOT NULL,bar_time TEXT NOT NULL,decision TEXT NOT NULL DEFAULT 'REJECTED');
CREATE INDEX IF NOT EXISTS momentum_radar_day ON high_momentum_radar(captured_at);
CREATE TRIGGER IF NOT EXISTS opportunity_quote_insert AFTER INSERT ON strategy_quotes BEGIN
 INSERT INTO opportunity_quotes VALUES(NEW.symbol,NEW.quote_time,NEW.received_at,NEW.price,NEW.source) ON CONFLICT(symbol,quote_time) DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS opportunity_quote_update AFTER UPDATE ON strategy_quotes BEGIN
 INSERT INTO opportunity_quotes VALUES(NEW.symbol,NEW.quote_time,NEW.received_at,NEW.price,NEW.source) ON CONFLICT(symbol,quote_time) DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS opportunity_mini_insert AFTER INSERT ON bist_ai_decisions WHEN NEW.status='APPROVED' BEGIN
 INSERT OR IGNORE INTO opportunity_events SELECT 'MINI:'||NEW.signal_key,'SCALP',NEW.symbol,NEW.signal_key,'APPROVED',NEW.completed_at,NEW.bar_time,COALESCE((SELECT metrics_json FROM bist_funnel_candidates WHERE symbol=NEW.symbol AND bar_time=NEW.bar_time ORDER BY observed_at LIMIT 1),'{}'),(SELECT json_object('price',price,'quote_time',quote_time,'received_at',received_at,'source',source) FROM strategy_quotes WHERE symbol=NEW.symbol AND received_at<=NEW.completed_at),'OBSERVED';
END;
CREATE TRIGGER IF NOT EXISTS opportunity_mini_update AFTER UPDATE OF status ON bist_ai_decisions WHEN NEW.status='APPROVED' AND OLD.status!='APPROVED' BEGIN
 INSERT OR IGNORE INTO opportunity_events SELECT 'MINI:'||NEW.signal_key,'SCALP',NEW.symbol,NEW.signal_key,'APPROVED',NEW.completed_at,NEW.bar_time,COALESCE((SELECT metrics_json FROM bist_funnel_candidates WHERE symbol=NEW.symbol AND bar_time=NEW.bar_time ORDER BY observed_at LIMIT 1),'{}'),(SELECT json_object('price',price,'quote_time',quote_time,'received_at',received_at,'source',source) FROM strategy_quotes WHERE symbol=NEW.symbol AND received_at<=NEW.completed_at),'OBSERVED';
END;
CREATE TRIGGER IF NOT EXISTS opportunity_scalp_reserve AFTER INSERT ON scalp_sniper_queue BEGIN
 INSERT OR IGNORE INTO opportunity_events SELECT 'RESERVE:SCALP:'||NEW.signal_key,'SCALP',NEW.symbol,NEW.signal_key,'RESERVE',NEW.observed_at,NEW.bar_time,NEW.metrics_json,(SELECT json_object('price',price,'quote_time',quote_time,'received_at',received_at,'source',source) FROM strategy_quotes WHERE symbol=NEW.symbol AND received_at<=NEW.observed_at),'OBSERVED';
END;
CREATE TRIGGER IF NOT EXISTS opportunity_trend_reserve AFTER INSERT ON trend_radar_queue BEGIN
 INSERT OR IGNORE INTO opportunity_events SELECT 'RESERVE:SWING:'||NEW.signal_key,'SWING',NEW.symbol,NEW.signal_key,'RESERVE',NEW.observed_at,NEW.bar_time,NEW.metrics_json,(SELECT json_object('price',price,'quote_time',quote_time,'received_at',received_at,'source',source) FROM strategy_quotes WHERE symbol=NEW.symbol AND received_at<=NEW.observed_at),'OBSERVED';
END;
-- Recover known stages, never fabricate their historical entry quote.
INSERT OR IGNORE INTO opportunity_events SELECT 'HOT:SCALP:'||symbol||':'||bar_time,'SCALP',symbol,symbol||':'||bar_time,'HOT',MIN(observed_at),bar_time,metrics_json,NULL,'ARCHIVED_WITHOUT_ENTRY_QUOTE' FROM bist_funnel_candidates GROUP BY symbol,bar_time;
INSERT OR IGNORE INTO opportunity_events SELECT 'MINI:'||signal_key,'SCALP',symbol,signal_key,'APPROVED',completed_at,bar_time,'{}',NULL,'ARCHIVED_WITHOUT_ENTRY_QUOTE' FROM bist_ai_decisions WHERE status='APPROVED' AND completed_at IS NOT NULL;
INSERT OR IGNORE INTO opportunity_events SELECT 'RESERVE:SCALP:'||signal_key,'SCALP',symbol,signal_key,'RESERVE',observed_at,bar_time,metrics_json,NULL,'ARCHIVED_WITHOUT_ENTRY_QUOTE' FROM scalp_sniper_queue;
INSERT OR IGNORE INTO opportunity_events SELECT 'RESERVE:SWING:'||signal_key,'SWING',symbol,signal_key,'RESERVE',observed_at,bar_time,metrics_json,NULL,'ARCHIVED_WITHOUT_ENTRY_QUOTE' FROM trend_radar_queue;
INSERT OR IGNORE INTO opportunity_events SELECT 'APPROVED:SWING:'||signal_key,'SWING',symbol,signal_key,'APPROVED',observed_at,bar_time,metrics_json,NULL,'ARCHIVED_WITHOUT_ENTRY_QUOTE' FROM trend_radar_queue;
CREATE TRIGGER IF NOT EXISTS scalp_morning_premium_guard BEFORE INSERT ON virtual_trades WHEN NEW.strategy='SCALP' AND NEW.engine_version=2 AND CAST(strftime('%H',NEW.entry_time,'+3 hours') AS INTEGER)<13 BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM strategy_market_context c JOIN strategy_quotes q ON q.symbol=c.symbol WHERE c.symbol=NEW.symbol AND c.session_date=date(NEW.entry_time,'+3 hours') AND (q.price/c.previous_close-1)*100<6.5-0.000000001) THEN RAISE(ABORT,'PAPER_MORNING_PREMIUM_OR_REFERENCE_MISSING') END;
END;
CREATE TABLE IF NOT EXISTS opportunity_bar_observations(symbol TEXT NOT NULL,interval TEXT NOT NULL,bar_time TEXT NOT NULL,first_received_at TEXT NOT NULL,PRIMARY KEY(symbol,interval,bar_time));
CREATE TRIGGER IF NOT EXISTS opportunity_intraday_bar AFTER INSERT ON bist_bridge_bars WHEN NEW.source='YAHOO_INDICATIVE' AND date(NEW.bar_time,'+3 hours')=date(NEW.received_at,'+3 hours') BEGIN
 INSERT INTO opportunity_bar_observations VALUES(NEW.symbol,NEW.interval,NEW.bar_time,NEW.received_at) ON CONFLICT(symbol,interval,bar_time) DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS opportunity_hour_bar AFTER INSERT ON trend_bars WHEN NEW.interval='60m' AND date(NEW.bar_time,'+3 hours')=date(NEW.received_at,'+3 hours') BEGIN
 INSERT INTO opportunity_bar_observations VALUES(NEW.symbol,NEW.interval,NEW.bar_time,NEW.received_at) ON CONFLICT(symbol,interval,bar_time) DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS opportunity_hour_bar_update AFTER UPDATE ON trend_bars WHEN NEW.interval='60m' AND date(NEW.bar_time,'+3 hours')=date(NEW.received_at,'+3 hours') BEGIN
 INSERT INTO opportunity_bar_observations VALUES(NEW.symbol,NEW.interval,NEW.bar_time,NEW.received_at) ON CONFLICT(symbol,interval,bar_time) DO NOTHING;
END;
