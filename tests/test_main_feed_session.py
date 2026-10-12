import datetime as dt,sys,unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'bridge'))
from main_feed_session import loop,scan_cycle

class MainSessionTests(unittest.TestCase):
 def test_cadence_without_overlapping_cycles(self):
  clock=[dt.datetime.fromisoformat('2026-10-12T11:00:00+03:00').timestamp()];starts=[]
  def scan(u,c):starts.append(clock[0]);clock[0]+=240
  loop('{}',clock=lambda:clock[0],sleep=lambda n:clock.__setitem__(0,clock[0]+n),scan=scan)
  self.assertEqual(len(starts),5);self.assertEqual([b-a for a,b in zip(starts,starts[1:])],[300]*4)
 def test_slow_cycles_never_overlap_or_fabricate_schedule(self):
  clock=[dt.datetime.fromisoformat('2026-10-12T11:00:00+03:00').timestamp()];starts=[]
  def scan(u,c):starts.append(clock[0]);clock[0]+=400
  loop('{}',clock=lambda:clock[0],sleep=lambda n:clock.__setitem__(0,clock[0]+n),scan=scan)
  self.assertTrue(all(b-a==400 for a,b in zip(starts,starts[1:])))
 def test_original_eight_shards_finalize_and_unique_run_ids(self):
  calls=[]
  def run(args,**kw):calls.append((args,kw['env']));return SimpleNamespace(returncode=0)
  codes,last=scan_cycle('{"symbols":[]}',2,run=run)
  self.assertEqual(codes,[0]*8);self.assertEqual(last,0);self.assertEqual(len(calls),9)
  self.assertEqual({e['BIST_SHARD_INDEX'] for a,e in calls if '--finalize' not in a},{str(i) for i in range(8)})
  self.assertTrue(all(e['BIST_RUN_ID'].endswith('-c2') for a,e in calls));self.assertEqual(calls[-1][0][-1],'--finalize')

if __name__=='__main__':unittest.main()
