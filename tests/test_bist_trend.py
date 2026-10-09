import datetime as dt
import pathlib
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'bridge'))
import bist_trend as trend
import bist_sync as feed
class TrendFeed(unittest.TestCase):
 def packet(self,interval,now):
  step=3600 if interval=='60m' else 86400
  times=[now-(220-i)*step for i in range(221)]
  return {'chart':{'result':[{'meta':{'currency':'TRY','instrumentType':'EQUITY','regularMarketTime':now-900},'timestamp':times,'indicators':{'quote':[{'open':[100]*221,'high':[101]*221,'low':[99]*221,'close':[100]*221,'volume':[1000]*221}]}}]}}
 def test_hourly_never_sends_unclosed_provider_delayed_bar(self):
  now=int(dt.datetime(2026,10,9,13,tzinfo=dt.timezone.utc).timestamp())
  with patch.object(feed,'request_json',return_value=self.packet('60m',now)):
   bars=trend.trend_history('ASTOR','60m',now)
  self.assertGreaterEqual(len(bars),200)
  self.assertLessEqual(dt.datetime.fromisoformat(bars[-1]['time'].replace('Z','+00:00')).timestamp()+3600,now-900)
 def test_daily_never_sends_today_and_missing_ema_history_fails(self):
  now=int(dt.datetime(2026,10,9,13,tzinfo=dt.timezone.utc).timestamp())
  with patch.object(feed,'request_json',return_value=self.packet('1d',now)):
   bars=trend.trend_history('ASTOR','1d',now)
  self.assertLess(bars[-1]['time'][:10],'2026-10-09')
  packet=self.packet('60m',now);packet['chart']['result'][0]['timestamp']=[]
  with patch.object(feed,'request_json',return_value=packet):
   with self.assertRaisesRegex(feed.FeedError,'HISTORY_MISSING'):trend.trend_history('ASTOR','60m',now)
 def test_quote_keeps_provider_clock_and_price_separate_from_bar_close(self):
  now=int(dt.datetime(2026,10,9,13,tzinfo=dt.timezone.utc).timestamp())
  packet=self.packet('60m',now);m=packet['chart']['result'][0]['meta'];m['regularMarketPrice']=101.5
  with patch.object(feed,'request_json',return_value=packet):data=feed.yahoo('ASTOR',now,with_quote=True)
  self.assertEqual(data['quote']['price'],101.5)
  self.assertEqual(dt.datetime.fromisoformat(data['quote']['quote_time'].replace('Z','+00:00')).timestamp(),now-900)
  self.assertEqual(data['bars'][-1]['close'],100)
