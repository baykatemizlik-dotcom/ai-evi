import copy,json,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'bridge'))
from trial_paper import reduce_minute,reconcile,features,predict,model_vector,references_before

def state():return {'initial_cash':'25000','cash':'25000','realised_pnl':'0','ledger':[],'open_trades':[],'closed_trades':[]}
M=30000000//1440*1440+630
def candidate(m):return {'symbol':'TEST','minute':m,'source':'INTRADAY','score':.01,'turnover':10000000}

class TrialPaperTests(unittest.TestCase):
 def test_fee_integer_budget_and_isolated_account(self):
  a=state();b=state();m=M
  reduce_minute(a,{'TEST':{m:[100,101,99.9,100.5,100]}},m,[candidate(m)],'2026-10-12T08:00:00Z')
  self.assertEqual(b,state());self.assertEqual(a['open_trades'][0]['lot_count'],249);self.assertGreaterEqual(float(a['cash']),0);reconcile(a)
 def test_same_bar_stop_wins_tp(self):
  s=state();m=M
  reduce_minute(s,{'TEST':{m:[100,110,90,103,100]}},m,[candidate(m)],'2026-10-12T08:00:00Z')
  self.assertEqual(s['closed_trades'][0]['exit_reason'],'ENTRY_BAR_SL_STOP_FIRST');self.assertLess(float(s['cash']),25000);reconcile(s)
 def test_gap_stop_real_open_and_cash(self):
  s=state();m=M
  reduce_minute(s,{'TEST':{m:[100,101,99.9,100,100]}},m,[candidate(m)],'x')
  reduce_minute(s,{'TEST':{m+1:[80,82,79,81,100]}},m+1,[],'y')
  self.assertEqual(s['closed_trades'][0]['exit_reason'],'GAP_SL');self.assertEqual(s['closed_trades'][0]['exit_price'],'79.920');reconcile(s)
 def test_missing_open_no_fill(self):
  s=state();m=M;reduce_minute(s,{},m,[candidate(m)],'x');self.assertEqual(s['ledger'],[])
 def test_high_resets_idle_clock(self):
  s=state();m=M
  reduce_minute(s,{'TEST':{m:[100,101,99.9,100,1]}},m,[candidate(m)],'x')
  reduce_minute(s,{'TEST':{m+40:[101,102,100,101,1]}},m+40,[],'x')
  reduce_minute(s,{'TEST':{m+45:[101,102,100,101,1]}},m+45,[],'x')
  self.assertEqual(len(s['open_trades']),1)
  reduce_minute(s,{'TEST':{m+85:[101,102,100,101,1]}},m+85,[],'x');self.assertEqual(s['closed_trades'][0]['exit_reason'],'IDLE_45_ACTIVE_MINUTES')
 def test_frozen_export_models_present(self):
  p=Path(__file__).resolve().parents[1]/'bridge/trial_models.json';d=json.loads(p.read_text())
  self.assertEqual(set(d['models']),{'V4QQ','V4PT'});self.assertGreaterEqual(len(d['references']),600)
  for m in d['models'].values():self.assertGreaterEqual(m['training_rows'],200);self.assertLess(m['export_max_error'],1e-12)
 def test_future_bars_do_not_change_feature(self):
  m=M;b={k:[99,100,98.9,99.5,1000] for k in range(m-30,m-10)}
  b.update({k:[100,101.1,99.99,101,1000000] for k in range(m-10,m)})
  ref={'opening_volumes':[100]*20,'clock_volumes':{str(630):[100]*20},'previous_close':100}
  a=features('TEST',b,ref,m,.5);self.assertIsNotNone(a);b[m+20]=[100,9000,1,9000,1e9];self.assertEqual(a,features('TEST',b,ref,m,.5))

if __name__=='__main__':unittest.main()
