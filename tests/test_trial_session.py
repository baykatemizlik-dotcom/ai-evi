import datetime as dt,sys,unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'bridge'))
from trial_session import market_window,next_delay,run_session

class SessionTests(unittest.TestCase):
 def test_weekday_market_boundaries(self):
  ts=lambda s:dt.datetime.fromisoformat(s).timestamp()
  self.assertTrue(market_window(ts('2026-10-12T10:00:00+03:00')))
  self.assertFalse(market_window(ts('2026-10-12T09:59:00+03:00')))
  self.assertFalse(market_window(ts('2026-10-12T18:40:00+03:00')))
  self.assertFalse(market_window(ts('2026-10-11T11:00:00+03:00')))
 def test_cadence_accounts_for_fetch_duration(self):
  self.assertEqual(next_delay(100,125),275);self.assertEqual(next_delay(100,500),0)
 def test_five_polls_no_overlapping_writer_and_no_cron(self):
  epoch=dt.datetime.fromisoformat('2026-10-12T11:00:00+03:00').timestamp();clock=[epoch];starts=[]
  def run(args,**kwargs):starts.append(clock[0]);clock[0]+=20;return SimpleNamespace(returncode=0)
  def sleep(n):clock[0]+=n
  run_session(clock=lambda:clock[0],sleep=sleep,run=run)
  self.assertEqual(len(starts),5);self.assertTrue(all(b-a==300 for a,b in zip(starts,starts[1:])))
 def test_poll_failure_does_not_skip_next_cycle(self):
  epoch=dt.datetime.fromisoformat('2026-10-12T11:00:00+03:00').timestamp();clock=[epoch];starts=[]
  def run(args,**kwargs):starts.append(clock[0]);clock[0]+=10;return SimpleNamespace(returncode=1)
  run_session(clock=lambda:clock[0],sleep=lambda n:clock.__setitem__(0,clock[0]+n),run=run)
  self.assertEqual(len(starts),5)

if __name__=='__main__':unittest.main()
