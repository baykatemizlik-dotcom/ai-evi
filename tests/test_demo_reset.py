"""Archive/reset checks only in an isolated SQLite database."""
import json
import pathlib
import sqlite3
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]

class DemoReset(unittest.TestCase):
    def test_archive_preserves_old_epoch_and_reset_is_not_repeated(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(pathlib.Path(directory) / 'paper.sqlite')
            subprocess.run(['python3', str(ROOT / 'tests/funnel_sqlite.py'), path],
                           input=json.dumps({'init': True}), text=True, check=True,
                           capture_output=True)
            db = sqlite3.connect(path)
            db.execute('CREATE TABLE bist_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL)')
            db.execute("INSERT INTO bist_settings VALUES('TOTAL_CAPITAL','5000','2026-10-09')")
            db.execute("INSERT INTO virtual_trades(strategy,symbol,signal_price,executed_price,lot_count,commission,entry_time,status,remaining_lots,engine_version) VALUES('SCALP','TEST',100,100,4,1,'2026-10-09T12:00:00Z','OPEN',4,1)")
            db.commit()
            sql = (ROOT / 'ops/demo_reset_20261012.sql').read_text()
            db.executescript('BEGIN;\n' + sql + '\nCOMMIT;')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM virtual_trades').fetchone()[0], 0)
            old = db.execute('SELECT status,lot_count,exit_price,pnl_net FROM demo_20261012_before_virtual_trades').fetchone()
            self.assertEqual(old, ('OPEN', 4, None, None))
            self.assertEqual(db.execute('SELECT SUM(available_cash) FROM paper_cash_accounts').fetchone()[0], 25000)
            self.assertEqual(db.execute('SELECT SUM(initial_cash) FROM paper_cash_accounts').fetchone()[0], 25000)
            with self.assertRaises(sqlite3.OperationalError):
                db.executescript('BEGIN;\n' + sql + '\nCOMMIT;')
            db.rollback()
            self.assertEqual(db.execute('SELECT COUNT(*) FROM demo_20261012_before_virtual_trades').fetchone()[0], 1)
            db.close()

if __name__ == '__main__':
    unittest.main()
