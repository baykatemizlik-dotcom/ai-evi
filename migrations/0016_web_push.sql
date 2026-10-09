CREATE TABLE IF NOT EXISTS push_subscriptions(endpoint TEXT PRIMARY KEY,p256dh TEXT NOT NULL,auth TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bist_push_events(id TEXT PRIMARY KEY,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bist_push_deliveries(event_id TEXT NOT NULL,endpoint TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL,next_attempt TEXT NOT NULL,lease_until TEXT,provider_status INTEGER,PRIMARY KEY(event_id,endpoint));
CREATE INDEX IF NOT EXISTS bist_push_events_expiry ON bist_push_events(expires_at);
DROP TRIGGER IF EXISTS bist_push_candidate;
CREATE TRIGGER bist_push_candidate AFTER INSERT ON bist_feed_signals WHEN NEW.status='PENDING' BEGIN
 INSERT OR IGNORE INTO bist_push_events VALUES('candidate:'||NEW.signal_key,json_object('title','BIST · Yeni AL sinyali','body',NEW.symbol||' iki AI tarafından onaylandı; sanal giriş bekliyor.','tag','candidate:'||NEW.signal_key),strftime('%Y-%m-%dT%H:%M:%fZ','now'),NEW.expires_at);
END;
DROP TRIGGER IF EXISTS bist_push_entry;
CREATE TRIGGER bist_push_entry AFTER INSERT ON virtual_trades WHEN NEW.feed_entry_key IS NOT NULL AND NEW.status='OPEN' BEGIN
 INSERT OR IGNORE INTO bist_push_events VALUES('entry:'||NEW.id,json_object('title','BIST · AL gerçekleşti (sanal)','body',NEW.symbol||' · '||CASE WHEN NEW.strategy='SWING' THEN 'Sniper' ELSE 'Scalp' END||' · '||NEW.lot_count||' lot · '||round(NEW.executed_price,4)||' TL','tag','entry:'||NEW.id),strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes'));
END;
DROP TRIGGER IF EXISTS bist_push_exit;
CREATE TRIGGER bist_push_exit AFTER UPDATE OF status ON virtual_trades WHEN OLD.status='OPEN' AND NEW.status='CLOSED' AND NEW.feed_entry_key IS NOT NULL BEGIN
 INSERT OR IGNORE INTO bist_push_events VALUES('exit:'||NEW.id,json_object('title','BIST · SAT gerçekleşti (sanal)','body',NEW.symbol||' · '||NEW.exit_reason||' · Net '||round(NEW.pnl_net,2)||' TL','tag','exit:'||NEW.id),strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes'));
END;