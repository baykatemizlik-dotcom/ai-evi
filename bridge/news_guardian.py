"""Deterministic entry guard. Never generates an order or changes exit rules."""
import datetime as dt
import json
import sqlite3

UTC=dt.timezone.utc
BIST_SOURCE='https://www.borsaistanbul.com/erd/menkul_tedbir_listesi.csv'

def schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS stock_intelligence(
        record_id TEXT NOT NULL, symbol TEXT NOT NULL, action_flag TEXT NOT NULL,
        severity INTEGER NOT NULL, reason TEXT NOT NULL, valid_from TEXT NOT NULL,
        valid_until TEXT NOT NULL, updated_at TEXT NOT NULL, source_url TEXT NOT NULL,
        evidence_status TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(record_id,symbol))''')
    db.execute('CREATE INDEX IF NOT EXISTS intel_symbol_active ON stock_intelligence(symbol,is_active,valid_from,valid_until)')

def stamp(s):
    value=dt.datetime.fromisoformat(s.replace('Z','+00:00'))
    if value.tzinfo is None:raise ValueError('INTEL_TIMEZONE_REQUIRED')
    return value.astimezone(UTC)

def project_record(db,payload,now=None):
    """Only deterministic official restrictions become effective BLACKLIST.

    AI source reports are advisory; keyword matches never silently gain authority.
    """
    schema(db)
    p=json.loads(payload) if isinstance(payload,str) else payload
    raw=p.get('official_restriction')
    if not raw or p.get('source_id')!='BIST_RESTRICTIONS' or p.get('source_url')!=BIST_SOURCE:return
    symbol=raw.get('symbol');start=stamp(raw['valid_from']);end=stamp(raw['valid_until']);asof=stamp(raw['source_as_of'])
    if not symbol or p.get('related_symbols')!=[symbol] or end<=start:raise ValueError('INVALID_OFFICIAL_INTELLIGENCE')
    current=now or dt.datetime.now(UTC)
    if asof>current+dt.timedelta(seconds=60):raise ValueError('FUTURE_INTELLIGENCE')
    # The user's risk policy blocks entry for all official listed measures.
    # This is a strategy policy, not a claim that every measure legally bans cash buying.
    db.execute('''INSERT OR IGNORE INTO stock_intelligence VALUES(?,?,?,?,?,?,?,?,?,?,1)''',
        (p['record_id'],symbol,'BLACKLIST',5,raw['name'],raw['valid_from'],raw['valid_until'],raw['source_as_of'],BIST_SOURCE,'OFFICIAL_RESTRICTION'))

def check_intelligence_filter(cursor,symbol,now=None):
    current=(now or dt.datetime.now(UTC)).astimezone(UTC).isoformat(timespec='seconds').replace('+00:00','Z')
    rows=cursor.execute('''SELECT action_flag,severity,reason,evidence_status,record_id
        FROM stock_intelligence WHERE symbol=? AND is_active=1 AND valid_from<=?
        AND valid_until>? ORDER BY CASE action_flag WHEN 'BLACKLIST' THEN 0
        WHEN 'PRIORITY_RADAR' THEN 1 ELSE 2 END,severity DESC,updated_at DESC''',
        (symbol,current,current)).fetchall()
    # NEW NEUTRAL does not override an older, still-active BLACKLIST.
    effective=[r for r in rows if r[3] in ('OFFICIAL_RESTRICTION','CONFIRMED_OFFICIAL_CONTENT')]
    if not effective:return {'action_flag':'NEUTRAL','severity':0,'reason':'Doğrulanmış aktif kayıt yok','coverage_status':'UNKNOWN','record_ids':[]}
    row=effective[0]
    return {'action_flag':row[0],'severity':row[1],'reason':row[2],'coverage_status':'PARTIAL','record_ids':[r[4] for r in effective]}

def validate_entry(symbol,technical_signal,cursor,now=None):
    if not technical_signal:return False
    return check_intelligence_filter(cursor,symbol,now)['action_flag']!='BLACKLIST'

def prioritize_candidates(candidates,cursor,now=None):
    """Only already technically approved candidates may enter this ranking.

    Preserve existing technical ordering within each group. No allocation/orders.
    """
    allowed=[]
    for candidate in candidates:
        if candidate.get('technical_signal') is not True:continue
        intel=check_intelligence_filter(cursor,candidate['symbol'],now)
        if intel['action_flag']!='BLACKLIST':allowed.append({**candidate,'intelligence':intel})
    return sorted(allowed,key=lambda c:0 if c['intelligence']['action_flag']=='PRIORITY_RADAR' else 1)
