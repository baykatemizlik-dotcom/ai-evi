-- One-time user-authorised paper reset. No price execution or fabricated PnL.
-- Old OPEN positions are cancelled by moving the entire old epoch to audit tables.
CREATE TABLE demo_20261012_before_virtual_trades AS SELECT * FROM virtual_trades;
CREATE TABLE demo_20261012_before_strategy_exit_legs AS SELECT * FROM strategy_exit_legs;
CREATE TABLE demo_20261012_before_paper_cash_accounts AS SELECT * FROM paper_cash_accounts;
CREATE TABLE demo_20261012_before_bist_exit_audit AS SELECT * FROM bist_exit_audit;
CREATE TABLE demo_20261012_before_bist_sniper_state AS SELECT * FROM bist_sniper_state;
CREATE TABLE demo_20261012_before_scalp_sniper_queue AS SELECT * FROM scalp_sniper_queue;
CREATE TABLE demo_20261012_before_trend_radar_queue AS SELECT * FROM trend_radar_queue;
CREATE TABLE demo_20261012_before_bist_feed_signals AS SELECT * FROM bist_feed_signals;
CREATE TABLE demo_20261012_before_bist_sniper_queue AS SELECT * FROM bist_sniper_queue;
CREATE TABLE demo_20261012_before_bist_settings AS SELECT * FROM bist_settings;
CREATE TABLE demo_20261012_epoch(id TEXT PRIMARY KEY,started_at TEXT NOT NULL,disposition TEXT NOT NULL,total_capital REAL NOT NULL);
INSERT INTO demo_20261012_epoch VALUES('20261012_25000',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'OLD_POSITIONS_CANCELLED_NO_MARKET_FILL',25000);
DELETE FROM strategy_exit_legs;
DELETE FROM bist_exit_audit;
DELETE FROM bist_sniper_state;
DELETE FROM virtual_trades;
UPDATE scalp_sniper_queue SET status='EXPIRED',reason='NEW_DEMO_EPOCH' WHERE status='READY';
UPDATE trend_radar_queue SET status='EXPIRED',reason='NEW_DEMO_EPOCH' WHERE status='READY';
UPDATE bist_feed_signals SET status='EXPIRED' WHERE status='PENDING';
UPDATE bist_sniper_queue SET status='EXPIRED' WHERE status IN ('READY','OPEN');
UPDATE paper_cash_accounts SET initial_cash=12500,available_cash=12500,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE strategy IN ('SCALP','SWING');
UPDATE bist_settings SET value='25000',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key='TOTAL_CAPITAL';
UPDATE bist_settings SET value='6250',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key='SCALP_SLOT_BUDGET';
