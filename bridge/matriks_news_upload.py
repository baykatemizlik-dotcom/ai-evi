#!/usr/bin/env python3
"""Durable local news/event spool; no model keys and no trading database access."""
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import urllib.request
import urllib.error

URL = 'https://ai-evi.baykatemizlik.workers.dev/bist/news/matriks/ingest'
MAX_LINE = 100_000

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def database(path):
    if Path(path).name.lower() in ('matriks_feed.sqlite', 'engine.sqlite'):
        raise ValueError('Use the separate news archive database')
    db = sqlite3.connect(path)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA synchronous=FULL')
    db.executescript('CREATE TABLE IF NOT EXISTS matriks_outbox(id TEXT PRIMARY KEY,payload_json TEXT NOT NULL,uploaded INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS matriks_file_cursors(path TEXT PRIMARY KEY,offset INTEGER NOT NULL);')
    return db

def read_spool(db, path):
    path = Path(path).resolve()
    if not path.exists():
        return 0
    row = db.execute('SELECT offset FROM matriks_file_cursors WHERE path=?', (str(path),)).fetchone()
    offset = row[0] if row else 0
    if path.stat().st_size < offset:
        raise ValueError('Spool file was truncated; keep it append-only')
    added = 0
    with path.open('rb') as source:
        source.seek(offset)
        with db:
            for _ in range(500):
                start = source.tell()
                line = source.readline(MAX_LINE + 1)
                if not line:
                    break
                if len(line) > MAX_LINE:
                    raise ValueError('Spool line too large at byte ' + str(start))
                if not line.endswith(b'\n'):
                    source.seek(start)
                    break
                payload = json.loads(line.decode('utf-8-sig'))
                if payload.get('kind') not in ('NEWS', 'FORMATION', 'DETECTOR', 'TREND'):
                    raise ValueError('Unsupported record at byte ' + str(start))
                text = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
                identity = hashlib.sha256(text.encode()).hexdigest()
                added += db.execute('INSERT OR IGNORE INTO matriks_outbox(id,payload_json) VALUES(?,?)', (identity, text)).rowcount
            db.execute('INSERT INTO matriks_file_cursors VALUES(?,?) ON CONFLICT(path) DO UPDATE SET offset=excluded.offset', (str(path), source.tell()))
    return added

def upload(db, token, sender=None):
    rows = db.execute('SELECT id,payload_json FROM matriks_outbox WHERE uploaded=0 ORDER BY rowid LIMIT 20').fetchall()
    if not rows:
        return 0
    records = [json.loads(row[1]) for row in rows]
    if sender is None:
        req = urllib.request.Request(URL, data=json.dumps({'records': records}, ensure_ascii=False).encode(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.build_opener(NoRedirect).open(req, timeout=30) as response:
                raw = response.read(100001)
                if len(raw) > 100000:
                    raise ValueError('Cloud response too large')
                result = json.loads(raw)
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
            raise ValueError('Upload HTTP ' + str(status)) from None
    else:
        result = sender(records)
    accepted = {(row.get('source_record_id'), row.get('kind')) for row in result.get('accepted', [])}
    if any((r['source_record_id'], r['kind']) not in accepted for r in records):
        raise ValueError('Cloud did not acknowledge the whole batch')
    with db:
        db.executemany('UPDATE matriks_outbox SET uploaded=1 WHERE id=?', [(row[0],) for row in rows])
    return len(rows)

def main():
    default = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'AI_Evi'
    parser = argparse.ArgumentParser()
    parser.add_argument('--spool', default=str(default / 'matriks_news_events.jsonl'))
    parser.add_argument('--db', default=str(default / 'news_archive.sqlite'))
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    Path(args.db).parent.mkdir(parents=True, exist_ok=True)
    token = getpass.getpass('Panel ACCESS_TOKEN (stored only in memory): ')
    db = database(args.db)
    print('Waiting for Matriks news/events. No trading commands are sent.')
    while True:
        try:
            added = read_spool(db, args.spool)
            sent = upload(db, token)
            pending = db.execute('SELECT count(*) FROM matriks_outbox WHERE uploaded=0').fetchone()[0]
            print(f'New: {added} | Uploaded: {sent} | Waiting: {pending}')
        except (ValueError, sqlite3.Error, OSError, urllib.error.URLError):
            print('Read/upload failed; local records retained. Check source format and connection.')
        if args.once:
            break
        time.sleep(10)

if __name__ == '__main__':
    main()
