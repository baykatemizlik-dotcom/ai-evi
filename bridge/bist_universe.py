"""Official KAP equity-market discovery, with a dated checked-in fallback."""
import datetime as dt
import json
import pathlib
import re
import urllib.request

KAP_URL = 'https://www.kap.org.tr/tr/Pazarlar'
EQUITY_MARKETS = {'YILDIZ PAZAR', 'ANA PAZAR', 'ALT PAZAR',
                  'YAKIN İZLEME PAZARI', 'PİYASA ÖNCESİ İŞLEM PLATFORMU'}

def parse_markets(html):
    decoder = json.JSONDecoder()
    fragments = []
    for script in re.findall(r'<script[^>]*>(.*?)</script>', html, re.S):
        if 'stockCode' not in script:
            continue
        match = re.fullmatch(r'self\.__next_f\.push\((.*)\);?', script.strip(), re.S)
        if match:
            payload = json.loads(match.group(1))
            if isinstance(payload, list) and len(payload) == 2 and isinstance(payload[1], str):
                fragments.append(payload[1])
    markets = {}
    for fragment in fragments:
        for match in re.finditer(r'\{"financialMarketOid"', fragment):
            row, _ = decoder.raw_decode(fragment, match.start())
            if row.get('financialMarketName') != 'PAY PİYASASI' or row.get('marketName') not in EQUITY_MARKETS:
                continue
            for company in row.get('marketDetailContentList', []):
                if company.get('fundOid') or 'IGS' not in company.get('types', '').split(','):
                    continue
                for symbol in re.split(r'[\s,]+', company.get('stockCode', '')):
                    if re.fullmatch(r'[A-Z0-9]{3,6}', symbol):
                        markets[symbol] = row['marketName']
    if len(markets)<400 or not {'THYAO','TUPRS','ASELS','EREGL'} <= markets.keys():
        raise ValueError('KAP_UNIVERSE_INCOMPLETE')
    return markets

def load_universe():
    try:
        request = urllib.request.Request(KAP_URL, headers={'User-Agent':'BIST-Cloud-Bridge/1.0'})
        with urllib.request.urlopen(request, timeout=25) as response:
            raw = response.read(6_000_001)
            if len(raw)>6_000_000:
                raise ValueError('KAP_RESPONSE_TOO_LARGE')
        markets = parse_markets(raw.decode('utf-8'))
        return {'symbols':sorted(markets), 'markets':markets, 'source':KAP_URL,
                'verified_at':dt.datetime.now(dt.timezone.utc).isoformat(), 'cached':False}
    except (OSError, ValueError):
        cached = json.loads(pathlib.Path(__file__).with_name('bist_universe_snapshot.json').read_text())
        age = dt.datetime.now(dt.timezone.utc)-dt.datetime.fromisoformat(cached['verified_at'])
        if not dt.timedelta(0) <= age <= dt.timedelta(days=7):
            raise ValueError('KAP_UNAVAILABLE_AND_SNAPSHOT_EXPIRED') from None
        cached['cached'] = True
        return cached


def partition(symbols, shard, count):
    if not 1 <= count <= 8 or not 0 <= shard < count:
        raise ValueError('INVALID_SHARD')
    return symbols[shard::count]

RISK_URL = 'https://www.borsaistanbul.com/erd/menkul_tedbir_listesi.csv'

def parse_restrictions(text, now=None):
    import csv
    import io
    from zoneinfo import ZoneInfo
    now = now or dt.datetime.now(dt.timezone.utc)
    rows = list(csv.reader(io.StringIO(text.lstrip('\ufeff')), delimiter=';'))
    stamp = dt.datetime.strptime(rows[0][0], '%d.%m.%Y %H:%M:%S').replace(tzinfo=ZoneInfo('Europe/Istanbul'))
    if stamp.date() != now.astimezone(stamp.tzinfo).date() or stamp>now or now-stamp>dt.timedelta(hours=24):
        raise ValueError('RESTRICTIONS_STALE')
    if len(rows)<2 or rows[1][1]!='İşlem Kodu' or rows[1][4]!='Tedbirin İlk Tarihi':
        raise ValueError('RESTRICTIONS_SCHEMA_CHANGED')
    blocked=set()
    for row in rows[2:]:
        if not any(row):continue
        if len(row)<6:raise ValueError('RESTRICTIONS_BAD_ROW')
        start=dt.datetime.strptime(row[4],'%d.%m.%Y').date()
        end=dt.datetime.strptime(row[5],'%d.%m.%Y').date()
        if start<=now.astimezone(stamp.tzinfo).date()<=end:
            if not re.fullmatch(r'[A-Z0-9]{3,6}',row[1]):raise ValueError('RESTRICTIONS_BAD_SYMBOL')
            blocked.add(row[1])
    expiry=dt.datetime.combine(stamp.date()+dt.timedelta(days=1),dt.time(),stamp.tzinfo)
    return {'source':RISK_URL,'as_of':stamp.astimezone(dt.timezone.utc).isoformat(),
            'valid_until':expiry.astimezone(dt.timezone.utc).isoformat(),'excluded':sorted(blocked)}

def restrict_universe(universe):
    try:
        req=urllib.request.Request(RISK_URL,headers={'User-Agent':'BIST-Cloud-Bridge/1.0'})
        with urllib.request.urlopen(req,timeout=25) as response:
            raw=response.read(1_000_001)
            if len(raw)>1_000_000:raise ValueError('RESTRICTIONS_TOO_LARGE')
        risk=parse_restrictions(raw.decode('utf-8-sig'))
        eligible=[s for s in universe['symbols'] if universe['markets'].get(s) in {'YILDIZ PAZAR','ANA PAZAR'}
                  and s not in risk['excluded']]
        universe.update(eligible_symbols=eligible,risk=risk,risk_status='VERIFIED_OFFICIAL_RESTRICTIONS')
    except (OSError,ValueError,IndexError):
        # Never invent a clean risk list when the official list is unavailable.
        universe.update(eligible_symbols=[],risk_status='BLOCKED_RESTRICTIONS_UNAVAILABLE')
    return universe
