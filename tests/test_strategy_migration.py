import json,pathlib,sqlite3,subprocess,tempfile,unittest
class Migration(unittest.TestCase):
 def test_migration_preserves_cash_and_open_trade_and_blocks_unrecorded_final_exit(self):
  root=pathlib.Path(__file__).resolve().parents[1]
  with tempfile.TemporaryDirectory() as tmp:
   path=pathlib.Path(tmp)/'db.sqlite'
   subprocess.run(['python3',str(root/'tests/funnel_sqlite.py'),str(path)],input=json.dumps({'init':True,'pre_isolation':True}),text=True,capture_output=True,check=True)
   db=sqlite3.connect(path)
   db.execute("INSERT INTO virtual_trades(strategy,symbol,signal_price,executed_price,lot_count,commission,entry_time,status,slot_id) VALUES('SCALP','RTALB',2.56,2.56512,486,2.49329664,'2026-10-09T12:15:00Z','OPEN',1)")
   db.execute("UPDATE paper_cash_accounts SET available_cash=1197.112284896877 WHERE strategy='SCALP'")
   before=db.execute('SELECT strategy,available_cash FROM paper_cash_accounts ORDER BY strategy').fetchall()
   db.executescript((root/'migrations/0017_strategy_isolation.sql').read_text())
   db.executescript((root/'migrations/0018_scalp_runner.sql').read_text())
   self.assertEqual(before,db.execute('SELECT strategy,available_cash FROM paper_cash_accounts ORDER BY strategy').fetchall())
   self.assertEqual(db.execute("SELECT status,lot_count,remaining_lots,engine_version FROM virtual_trades WHERE symbol='RTALB'").fetchone(),('OPEN',486,486,2))
   with self.assertRaisesRegex(sqlite3.IntegrityError,'INVALID_FINAL_ACCOUNTING'):
    db.execute("UPDATE virtual_trades SET status='CLOSED',remaining_lots=0,pnl_net=0 WHERE symbol='RTALB'")
