import importlib.util
import pathlib
import sqlite3
import unittest
from unittest.mock import patch
ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('sender', ROOT/'bridge/bist_sync.py')
sender = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sender)

class Bars(unittest.TestCase):
    def test_incomplete_invalid_and_future_are_filtered(self):
        self.assertIsNone(sender.normalize('TUPRS', 1000, [10,11,9,10,100], 1800))
        self.assertIsNone(sender.normalize('TUPRS', 1000, [10,11,12,10,100], 2000))
        self.assertIsNone(sender.normalize('TUPRS', 1000, [10,11,9,float('nan'),100], 2000))
        self.assertIsNotNone(sender.normalize('TUPRS', 1000, [10,11,9,10,100], 2000))
    def test_yahoo_null_bar_not_sent(self):
        data={'chart':{'result':[{'timestamp':[1000,1900], 'indicators':{'quote':[
            {'open':[10,None],'high':[11,11],'low':[9,9],'close':[10,10],'volume':[100,100]}]}}]}}
        with patch.object(sender,'request_json',return_value=data):
            self.assertEqual(len(sender.yahoo('TUPRS',2000)),1)

class Accounting(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:')
        self.db.executescript('''
        CREATE TABLE virtual_trades(id INTEGER PRIMARY KEY AUTOINCREMENT,strategy TEXT NOT NULL,
         symbol TEXT NOT NULL,signal_price REAL,executed_price REAL,lot_count INTEGER,commission REAL,
         entry_time TEXT,exit_time TEXT,exit_price REAL,pnl_net REAL,exit_reason TEXT,status TEXT,slot_id INTEGER);
        CREATE TABLE paper_cash_accounts(strategy TEXT PRIMARY KEY,initial_cash REAL,available_cash REAL,updated_at TEXT);
        ''')
        self.db.executescript((ROOT/'migrations/0010_cloud_bridge.sql').read_text())
    def enter(self, key='a', symbol='TUPRS', slot=1):
        self.db.execute("INSERT INTO bist_feed_signals VALUES(?,?,?,'2026-10-09T07:16:00.000Z','2026-10-09T08:00:00.000Z','YAHOO_INDICATIVE','PENDING','{}')",(key,symbol,'2026-10-09T07:00:00.000Z'))
        self.db.execute("INSERT INTO virtual_trades(strategy,symbol,signal_price,executed_price,lot_count,commission,entry_time,status,slot_id,feed_entry_key) VALUES('SCALP',?,100,100.2,12,2.4048,'2026-10-09T07:30:00.000Z','OPEN',?,?)",(symbol,slot,key))
    def cash(self):
        return self.db.execute("SELECT available_cash FROM paper_cash_accounts WHERE strategy='SCALP'").fetchone()[0]
    def test_two_slots_and_duplicate_never_debit(self):
        self.enter(); self.enter('b','THYAO',2)
        cash=self.cash()
        with self.assertRaises(sqlite3.IntegrityError):self.enter('c','ASELS',1)
        self.assertEqual(self.cash(),cash)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM virtual_trades').fetchone()[0],2)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO virtual_trades SELECT NULL,strategy,symbol,signal_price,executed_price,lot_count,commission,entry_time,exit_time,exit_price,pnl_net,exit_reason,status,slot_id,feed_entry_key FROM virtual_trades WHERE id=1")
        self.assertEqual(self.cash(),cash)
    def test_close_credit_is_exactly_once(self):
        self.enter();cost=100.2*12+2.4048
        self.db.execute("UPDATE virtual_trades SET status='CLOSED',exit_price=104,exit_time='2026-10-09T08:00:00.000Z',pnl_net=? WHERE id=1 AND status='OPEN'",(104*12*.998-cost,))
        cash=self.cash()
        self.assertAlmostEqual(cash,2500-cost+104*12*.998)
        self.db.execute("UPDATE virtual_trades SET status='CLOSED' WHERE id=1 AND status='OPEN'")
        self.assertEqual(self.cash(),cash)
    def test_before_signal_fill_and_bad_exit_rejected(self):
        self.enter()
        cash=self.cash()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE virtual_trades SET status='CLOSED',exit_price=104,exit_time='2026-10-09T08:00:00Z',pnl_net=999999 WHERE id=1")
        self.assertEqual(self.cash(),cash)
        self.db.execute("INSERT INTO bist_feed_signals VALUES('b','THYAO','2026-10-09T07:00:00Z','2026-10-09T07:31:00Z','2026-10-09T08:00:00Z','YAHOO_INDICATIVE','PENDING','{}')")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO virtual_trades(strategy,symbol,executed_price,lot_count,commission,entry_time,status,slot_id,feed_entry_key) VALUES('SCALP','THYAO',100,1,.2,'2026-10-09T07:30:00Z','OPEN',2,'b')")
        self.assertEqual(self.cash(),cash)
    def test_low_balance_does_not_leave_open_trade(self):
        self.db.execute("UPDATE paper_cash_accounts SET available_cash=100")
        with self.assertRaises(sqlite3.IntegrityError):self.enter()
        self.assertEqual(self.cash(),100)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM virtual_trades').fetchone()[0],0)

if __name__=='__main__':unittest.main()
