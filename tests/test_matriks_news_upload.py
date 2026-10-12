import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('upload', Path(__file__).parents[1] / 'bridge/matriks_news_upload.py')
upload = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upload)

class UploadTests(unittest.TestCase):
    def test_commit_before_network_and_retry_dedup(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'spool.jsonl'
            item = {'kind': 'NEWS', 'source_record_id': '1', 'headline': 'Haber'}
            path.write_text(json.dumps(item) + '\n' + json.dumps(item) + '\n', encoding='utf-8')
            db = upload.database(Path(folder) / 'news_archive.sqlite')
            self.assertEqual(upload.read_spool(db, path), 1)
            def failed(records):
                other = upload.database(Path(folder) / 'news_archive.sqlite')
                self.assertEqual(other.execute('SELECT count(*) FROM matriks_outbox').fetchone()[0], 1)
                other.close()
                raise ValueError('Network failed')
            with self.assertRaises(ValueError):
                upload.upload(db, 'not-real', failed)
            self.assertEqual(upload.read_spool(db, path), 0)
            self.assertEqual(db.execute('SELECT uploaded FROM matriks_outbox').fetchone()[0], 0)
            self.assertEqual(upload.upload(db, 'not-real', lambda records: {'accepted': records}), 1)
            self.assertEqual(upload.upload(db, 'not-real', lambda records: self.fail('Repeated network call')), 0)
            db.close()

    def test_partial_line_waits_and_bad_ack_preserves_record(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'spool.jsonl'
            path.write_text('{"kind":"FORMATION","source_record_id":"f"}', encoding='utf-8')
            db = upload.database(Path(folder) / 'news_archive.sqlite')
            self.assertEqual(upload.read_spool(db, path), 0)
            with path.open('a', encoding='utf-8') as file:
                file.write('\n')
            self.assertEqual(upload.read_spool(db, path), 1)
            with self.assertRaises(ValueError):
                upload.upload(db, 'not-real', lambda records: {'accepted': []})
            self.assertEqual(db.execute('SELECT uploaded FROM matriks_outbox').fetchone()[0], 0)
            db.close()

if __name__ == '__main__':
    unittest.main()
