import importlib.util
import pathlib
import json
import sqlite3
import unittest
import sys
from unittest.mock import patch
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'bridge'))
spec = importlib.util.spec_from_file_location('sender', ROOT/'bridge/bist_sync.py')
sender = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sender)

class Bars(unittest.TestCase):
    def test_incomplete_invalid_and_future_are_filtered(self):
        self.assertIsNone(sender.normalize('TUPRS', 900, [10,11,9,10,100], 1799))
        self.assertIsNone(sender.normalize('TUPRS', 900, [10,11,12,10,100], 2000))
        self.assertIsNone(sender.normalize('TUPRS', 900, [10,11,9,float('nan'),100], 2000))
        self.assertIsNotNone(sender.normalize('TUPRS', 900, [10,11,9,10,100], 2000))
    def test_snapshot_timestamp_is_rejected(self):
        self.assertIsNone(sender.normalize('TUPRS', 1435, [10,11,9,10,100], 3000))
        self.assertIsNotNone(sender.normalize('TUPRS', 900, [10,11,9,10,100], 1800))
    def test_yahoo_null_bar_not_sent(self):
        data={'chart':{'result':[{'meta':{'instrumentType':'EQUITY','regularMarketTime':2000},'timestamp':[900,1800], 'indicators':{'quote':[
            {'open':[10,None],'high':[11,11],'low':[9,9],'close':[10,10],'volume':[100,100]}]}}]}}
        with patch.object(sender,'request_json',return_value=data):
            self.assertEqual(len(sender.yahoo('TUPRS',2000)),1)

class Funnel(unittest.TestCase):
    def candles(self,symbol,last):
        history=[dict(symbol=symbol,interval='15m',time=f'2026-10-08T{10+i//4:02d}:{i%4*15:02d}:00.000Z',open=99,high=100,low=98,close=99,volume=100) for i in range(20)]
        return history+[dict(symbol=symbol,interval='15m',time='2026-10-09T07:00:00.000Z',**last)]
    def test_vectorized_all_conditions_and_risk_exclusion(self):
        good=dict(open=100,high=104,low=100,close=103.5,volume=200)
        bars=self.candles('TUPRS',good)+self.candles('ASELS',{**good,'close':100.1})+self.candles('THYAO',{**good,'high':110})+self.candles('EREGL',good)
        hot=sender.stage_one(bars,{'TUPRS','ASELS','THYAO'})
        self.assertEqual(list(hot.symbol),['TUPRS'])
        self.assertEqual(hot.iloc[0].rvol,2)
    def test_delayed_provider_clock_rejects_in_progress_aligned_candle(self):
        data={'chart':{'result':[{'meta':{'instrumentType':'EQUITY','regularMarketTime':2000},
         'timestamp':[900,1800], 'indicators':{'quote':[{'open':[10,10],'high':[11,11],'low':[9,9],'close':[10,10],'volume':[100,100]}]}}]}}
        with patch.object(sender,'request_json',return_value=data):
            rows=sender.yahoo('TUPRS',4000)
            self.assertEqual(len(rows),1)
    def test_restrictions_active_expiry_and_stale_rejected(self):
        from bist_universe import parse_restrictions
        from datetime import datetime,timezone
        text='09.10.2026 08:29:00;\nPay Adı;İşlem Kodu;Uygulanan Tedbir Kodu;Uygulanan Tedbir Adı;Tedbirin İlk Tarihi;Tedbirin Son Tarihi;\nX;TUPRS;PBRUT;BRÜT TAKAS;01.10.2026;09.10.2026;\nX;ASELS;PBRUT;BRÜT TAKAS;01.10.2026;08.10.2026;'
        risk=parse_restrictions(text,datetime(2026,10,9,8,tzinfo=timezone.utc))
        self.assertEqual(risk['excluded'],['TUPRS'])
        with self.assertRaises(ValueError):parse_restrictions(text,datetime(2026,10,10,8,tzinfo=timezone.utc))

class Universe(unittest.TestCase):
    def test_official_market_parser_and_no_fund_or_bond_issuers(self):
        from bist_universe import parse_markets
        symbols=['THYAO','TUPRS','ASELS','EREGL']+[f'T{i:04d}' for i in range(420)]
        rows=[{'stockCode':s,'types':'IGS','fundOid':None} for s in symbols]
        markets=[{'financialMarketOid':'test','financialMarketName':'PAY PİYASASI',
                  'marketName':'ANA PAZAR','marketDetailContentList':rows},
                 {'financialMarketOid':'test2','financialMarketName':'BORÇLANMA ARAÇLARI PİYASASI',
                  'marketName':'ANA PAZAR','marketDetailContentList':[{'stockCode':'BOND','types':'IGS'}]}]
        fragment='test:'+json.dumps(markets)
        html='<script>self.__next_f.push('+json.dumps([1,fragment])+')</script>'
        result=parse_markets(html)
        self.assertEqual(set(result),set(symbols))
        self.assertNotIn('BOND',result)
    def test_truncated_kap_response_uses_verified_snapshot(self):
        import bist_universe
        import http.client
        with patch.object(bist_universe,'fetch_bytes',side_effect=http.client.IncompleteRead(b'partial')):
            universe=bist_universe.load_universe()
            self.assertTrue(universe['cached'])
            self.assertEqual(len(universe['symbols']),631)
    def test_all_eight_partitions_cover_universe_once(self):
        from bist_universe import partition
        symbols=[f'T{i:04d}' for i in range(631)]
        parts=[partition(symbols,i,8) for i in range(8)]
        self.assertEqual(sorted(x for p in parts for x in p),symbols)
        self.assertEqual(len(set(x for p in parts for x in p)),631)
        self.assertLessEqual(max(map(len,parts))-min(map(len,parts)),1)

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

class ExternalReview(unittest.TestCase):
    def test_schema_rejects_invalid_review(self):
        import bist_review
        valid={'summary':'Denetim tamamlandı','issues':[],'calibration':['Ölçüm gerekli']}
        self.assertEqual(bist_review.validate_review(valid),valid)
        with self.assertRaises(bist_review.FeedError):bist_review.validate_review({**valid,'issues':[123]})
    def test_missing_external_key_records_status_without_google_call(self):
        import bist_review
        with patch.dict('os.environ',{'GEMINI_API_KEY':''}),patch.object(bist_review,'worker_call',return_value={}) as worker,patch.object(bist_review,'request_json') as google:
            self.assertEqual(bist_review.main(),0)
            google.assert_not_called()
            self.assertEqual(worker.call_args.args[1]['status'],'MISSING_KEY')

if __name__=='__main__':unittest.main()
