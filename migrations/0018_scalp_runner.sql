-- Apply once after 0017; preserves balances, lots, Trend state and exit history.
ALTER TABLE virtual_trades ADD COLUMN scalp_runner_started_at TEXT;
ALTER TABLE strategy_exit_legs ADD COLUMN activation_time TEXT;
CREATE TRIGGER scalp_runner_min_lots BEFORE INSERT ON virtual_trades WHEN NEW.engine_version=2 AND NEW.strategy='SCALP' AND NEW.lot_count<2 BEGIN SELECT RAISE(ABORT,'PAPER_SCALP_MIN_TWO_LOTS'); END;
DROP TRIGGER strategy_leg_guard;
DROP TRIGGER strategy_leg_cash;
CREATE TRIGGER strategy_leg_guard BEFORE INSERT ON strategy_exit_legs BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM virtual_trades WHERE id=NEW.trade_id AND engine_version=2 AND status='OPEN' AND strategy=NEW.strategy AND symbol=NEW.symbol AND remaining_lots>=NEW.qty) THEN RAISE(ABORT,'INVALID_EXIT_LEG') END;
 SELECT CASE WHEN NEW.reason='TREND_TP1' AND NOT EXISTS(SELECT 1 FROM virtual_trades WHERE id=NEW.trade_id AND strategy='SWING' AND tp1_done=0 AND NEW.qty=CAST(lot_count/2 AS INTEGER) AND remaining_lots=lot_count) THEN RAISE(ABORT,'INVALID_TP1') END;
 SELECT CASE WHEN NEW.reason='SCALP_TP1' AND NOT EXISTS(SELECT 1 FROM virtual_trades WHERE id=NEW.trade_id AND strategy='SCALP' AND tp1_done=0 AND lot_count>=2 AND NEW.qty=CAST(lot_count*0.7 AS INTEGER) AND remaining_lots=lot_count AND NEW.activation_time IS NOT NULL AND julianday(NEW.activation_time)>=julianday(entry_time) AND julianday(NEW.activation_time)<=julianday(NEW.observed_at)) THEN RAISE(ABORT,'INVALID_SCALP_TP1') END;
 SELECT CASE WHEN NEW.reason NOT IN('TREND_TP1','SCALP_TP1') AND NOT EXISTS(SELECT 1 FROM virtual_trades WHERE id=NEW.trade_id AND remaining_lots=NEW.qty) THEN RAISE(ABORT,'EXIT_MUST_CLOSE_REMAINDER') END;
 SELECT CASE WHEN ABS(NEW.commission-NEW.executed_price*NEW.qty*0.002)>0.000001 OR NOT EXISTS(SELECT 1 FROM virtual_trades WHERE id=NEW.trade_id AND ABS(NEW.pnl_net-(NEW.executed_price*NEW.qty-NEW.commission-(executed_price+commission/lot_count)*NEW.qty))<0.000001) THEN RAISE(ABORT,'INVALID_EXIT_ACCOUNTING') END;
END;
CREATE TRIGGER strategy_leg_cash AFTER INSERT ON strategy_exit_legs BEGIN
 UPDATE paper_cash_accounts SET available_cash=available_cash+NEW.executed_price*NEW.qty-NEW.commission,updated_at=NEW.observed_at WHERE strategy=NEW.strategy;
 UPDATE virtual_trades SET remaining_lots=remaining_lots-NEW.qty,tp1_done=CASE WHEN NEW.reason IN('TREND_TP1','SCALP_TP1') THEN 1 ELSE tp1_done END,scalp_runner_started_at=CASE WHEN NEW.reason='SCALP_TP1' THEN NEW.activation_time ELSE scalp_runner_started_at END,trailing_stop=CASE WHEN NEW.reason IN('TREND_TP1','SCALP_TP1') THEN MAX(COALESCE(trailing_stop,0),(executed_price+commission/lot_count)/(0.998*0.998)) ELSE trailing_stop END WHERE id=NEW.trade_id;
 UPDATE virtual_trades SET status='CLOSED',exit_price=NEW.executed_price,exit_time=NEW.exit_time,exit_reason=NEW.reason,pnl_net=(SELECT SUM(pnl_net) FROM strategy_exit_legs WHERE trade_id=NEW.trade_id) WHERE id=NEW.trade_id AND remaining_lots=0;
END;
