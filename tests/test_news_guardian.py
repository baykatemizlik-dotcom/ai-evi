import datetime as dt,json,sqlite3,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'bridge'))
from news_guardian import schema,project_record,check_intelligence_filter,validate_entry,prioritize_candidates,BIST_SOURCE

class GuardianTests(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:');schema(self.db);self.now=dt.datetime(2026,10,13,7,tzinfo=dt.timezone.utc)
    def tearDown(self):self.db.close()
    def add(self,key,flag,start='2026-10-12T21:00:00Z',end='2026-10-13T21:00:00Z',evidence='CONFIRMED_OFFICIAL_CONTENT'):
        self.db.execute('INSERT INTO stock_intelligence VALUES(?,?,?,?,?,?,?,?,?,?,1)',(key,'THYAO',flag,5,key,start,end,'2026-10-13T06:00:00Z',BIST_SOURCE,evidence))
    def test_active_blacklist_beats_later_neutral_and_priority(self):
        self.add('black','BLACKLIST');self.add('neutral','NEUTRAL');self.add('priority','PRIORITY_RADAR');self.assertEqual(check_intelligence_filter(self.db.cursor(),'THYAO',self.now)['action_flag'],'BLACKLIST');self.assertFalse(validate_entry('THYAO',True,self.db.cursor(),self.now))
    def test_no_technical_signal_never_enters(self):
        self.add('priority','PRIORITY_RADAR');self.assertFalse(validate_entry('THYAO',False,self.db.cursor(),self.now));self.assertEqual(prioritize_candidates([{'symbol':'THYAO','technical_signal':False}],self.db.cursor(),self.now),[])
    def test_expired_future_and_unverified_flags_do_not_block(self):
        self.add('expired','BLACKLIST',end='2026-10-13T06:00:00Z');self.add('future','BLACKLIST',start='2026-10-13T08:00:00Z');self.add('rumor','BLACKLIST',evidence='AI_PROPOSAL');result=check_intelligence_filter(self.db.cursor(),'THYAO',self.now);self.assertEqual(result['coverage_status'],'UNKNOWN');self.assertTrue(validate_entry('THYAO',True,self.db.cursor(),self.now))
    def test_priority_ranks_only_technically_approved_candidates(self):
        self.add('priority','PRIORITY_RADAR');rows=prioritize_candidates([{'symbol':'AKBNK','technical_signal':True},{'symbol':'THYAO','technical_signal':True},{'symbol':'TUPRS','technical_signal':False}],self.db.cursor(),self.now);self.assertEqual([r['symbol'] for r in rows],['THYAO','AKBNK'])
    def test_only_official_deterministic_restrictions_are_projected(self):
        p={'record_id':'id','source_id':'BIST_RESTRICTIONS','source_url':BIST_SOURCE,'related_symbols':['THYAO'],'official_restriction':{'symbol':'THYAO','name':'BRÜT TAKAS','valid_from':'2026-10-12T21:00:00Z','valid_until':'2026-10-13T21:00:00Z','source_as_of':'2026-10-12T15:00:00Z'}};project_record(self.db,p,self.now);project_record(self.db,p,self.now);self.assertEqual(self.db.execute('SELECT count(*) FROM stock_intelligence').fetchone()[0],1);self.assertFalse(validate_entry('THYAO',True,self.db.cursor(),self.now));project_record(self.db,{**p,'record_id':'evil','source_url':'https://evil.test'},self.now);self.assertEqual(self.db.execute('SELECT count(*) FROM stock_intelligence').fetchone()[0],1)
if __name__=='__main__':unittest.main()
