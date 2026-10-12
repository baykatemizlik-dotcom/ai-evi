import hashlib,importlib.util,json,sqlite3,unittest,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'bridge'))
spec=importlib.util.spec_from_file_location('news_sync',Path(__file__).resolve().parents[1]/'bridge'/'news_sync.py');sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)
class SyncTests(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:');self.db.execute('CREATE TABLE news_archive(record_id TEXT PRIMARY KEY,payload_hash TEXT,content_hash TEXT,payload_json TEXT,saved_at REAL)');self.db.commit()
        p=json.dumps({'record_id':'a'*64,'content_hash':'b'*64,'analysis':{'summary':'Türkçe haber'}} ,ensure_ascii=False)
        self.row={'record_id':'a'*64,'content_hash':'b'*64,'payload_json':p,'payload_hash':hashlib.sha256(p.encode()).hexdigest()}
    def tearDown(self):self.db.close()
    def test_committed_before_ack_and_idempotent(self):
        a=sync.store_records(self.db,[self.row]);self.assertFalse(self.db.in_transaction);self.assertEqual(len(a),1);sync.store_records(self.db,[self.row]);self.assertEqual(self.db.execute('SELECT count(*) FROM news_archive').fetchone()[0],1)
    def test_hash_failure_rolls_back_whole_batch(self):
        bad={**self.row,'payload_hash':'c'*64}
        with self.assertRaises(ValueError):sync.store_records(self.db,[self.row,bad])
        self.assertEqual(self.db.execute('SELECT count(*) FROM news_archive').fetchone()[0],0)
    def test_local_collision_keeps_original(self):
        sync.store_records(self.db,[self.row]);p=json.dumps({'record_id':'a'*64,'content_hash':'b'*64,'analysis':{'summary':'Changed'}});changed={**self.row,'payload_json':p,'payload_hash':hashlib.sha256(p.encode()).hexdigest()}
        with self.assertRaises(ValueError):sync.store_records(self.db,[changed])
        self.assertEqual(self.db.execute('SELECT payload_hash FROM news_archive').fetchone()[0],self.row['payload_hash'])
if __name__=='__main__':unittest.main()
