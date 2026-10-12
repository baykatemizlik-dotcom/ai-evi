"""Standalone news archival client. Never opens the Matriks ledger or sends orders."""
import argparse, getpass, hashlib, json, re, sqlite3, time, urllib.parse, urllib.request
from pathlib import Path

def request_json(base, token, route, body=None):
    data=None if body is None else json.dumps(body).encode()
    req=urllib.request.Request(base+route,data=data,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},method='GET' if body is None else 'POST')
    # Do not forward credentials through redirects.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs): return None
    with urllib.request.build_opener(NoRedirect).open(req,timeout=40) as res:
        raw=res.read(2_000_001)
        if len(raw)>2_000_000:raise ValueError('RESPONSE_TOO_LARGE')
        return json.loads(raw)

def store_records(db,records):
    ack=[]
    with db:
        for r in records:
            payload=r['payload_json'];digest=hashlib.sha256(payload.encode('utf-8')).hexdigest()
            if digest!=r['payload_hash']:raise ValueError('PAYLOAD_HASH_MISMATCH')
            p=json.loads(payload)
            if p['record_id']!=r['record_id'] or p['content_hash']!=r['content_hash']:raise ValueError('RECORD_ID_MISMATCH')
            db.execute('INSERT OR IGNORE INTO news_archive VALUES(?,?,?,?,?)',(r['record_id'],digest,r['content_hash'],payload,time.time()))
            saved=db.execute('SELECT payload_hash FROM news_archive WHERE record_id=?',(r['record_id'],)).fetchone()
            if saved[0]!=digest:raise ValueError('LOCAL_VERSION_COLLISION')
            ack.append({'record_id':r['record_id'],'payload_hash':digest})
    # Only return ACKs after the transaction above has committed successfully.
    return ack

def main():
    p=argparse.ArgumentParser();p.add_argument('--url',default='https://ai-evi.baykatemizlik.workers.dev');p.add_argument('--database',default='news_archive.sqlite');p.add_argument('--client-id',default='berker-pc');p.add_argument('--watch',action='store_true');a=p.parse_args()
    u=urllib.parse.urlparse(a.url)
    if u.scheme!='https' or u.hostname!='ai-evi.baykatemizlik.workers.dev' or u.username or u.password or u.query or u.fragment or u.path not in ('','/'):raise SystemExit('EXPECTED_CONFIGURED_WORKER_HTTPS_URL')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,60}',a.client_id):raise SystemExit('INVALID_CLIENT_ID')
    target=Path(a.database).resolve()
    if target.name in ('matriks_feed.sqlite','engine.sqlite'):raise SystemExit('USE_SEPARATE_NEWS_DATABASE')
    token=getpass.getpass('Panel ACCESS_TOKEN (gizli): ').strip()
    if not token:raise SystemExit('TOKEN_REQUIRED')
    db=sqlite3.connect(target);db.execute('PRAGMA journal_mode=WAL');db.execute('PRAGMA synchronous=FULL')
    db.execute('CREATE TABLE IF NOT EXISTS news_archive(record_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,content_hash TEXT NOT NULL,payload_json TEXT NOT NULL,saved_at REAL NOT NULL)');db.commit()
    try:
        while True:
            try:
                total=0
                for _ in range(20):
                    records=request_json(a.url.rstrip('/'),token,'/bist/news/pending?limit=20')['records']
                    if not records:break
                    ack=store_records(db,records)
                    result=request_json(a.url.rstrip('/'),token,'/bist/news/ack',{'client_id':a.client_id,'records':ack})
                    if not all(x['acked'] for x in result['results']):raise ValueError('ACK_NOT_ACCEPTED')
                    total+=len(records)
                print('Haber arşivi senkronlandı:',total,'kayıt. Veritabanı:',target)
            except Exception as exc:
                # Avoid logging tokens, response bodies or request objects.
                print('Senkron tamamlanmadı; yerel kayıtlar korunuyor:',type(exc).__name__)
                if not a.watch:raise SystemExit(1) from None
            if not a.watch:break
            time.sleep(60)
    finally:db.close()

if __name__=='__main__':main()
