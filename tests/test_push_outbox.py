import pathlib,sqlite3,unittest
class Outbox(unittest.TestCase):
 def test_events_are_transactional_and_duplicate_close_does_not_notify_twice(self):
  db=sqlite3.connect(':memory:')
  db.executescript('CREATE TABLE bist_feed_signals(signal_key TEXT,status TEXT,symbol TEXT,expires_at TEXT); CREATE TABLE virtual_trades(id INTEGER PRIMARY KEY,feed_entry_key TEXT,status TEXT,symbol TEXT,strategy TEXT,lot_count INT,executed_price REAL,exit_reason TEXT,pnl_net REAL);')
  db.executescript((pathlib.Path(__file__).resolve().parents[1]/'migrations/0016_web_push.sql').read_text())
  db.execute("INSERT INTO bist_feed_signals VALUES('RTALB:t','PENDING','RTALB','2026-10-09T13:00:00Z')")
  db.execute("INSERT INTO virtual_trades VALUES(1,'RTALB:t','OPEN','RTALB','SCALP',10,2.5,NULL,NULL)")
  db.execute("UPDATE virtual_trades SET status='CLOSED',exit_reason='TIME_EXIT',pnl_net=-1 WHERE id=1")
  db.execute("UPDATE virtual_trades SET status='CLOSED' WHERE id=1")
  self.assertEqual([x[0] for x in db.execute('SELECT id FROM bist_push_events ORDER BY id')],['candidate:RTALB:t','entry:1','exit:1'])
  db.rollback()
  self.assertEqual(db.execute('SELECT COUNT(*) FROM bist_push_events').fetchone()[0],0)
