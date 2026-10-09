#!/usr/bin/env python3
"""Standard-library cloud bridge. Never prints keys or provider response bodies."""
import datetime as dt
import hashlib
import http.client
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from zoneinfo import ZoneInfo

from bist_universe import load_universe, partition, restrict_universe
import re
import pandas as pd
import numpy as np

UTC = dt.timezone.utc
TRT = ZoneInfo('Europe/Istanbul')
MIN_DAILY_TURNOVER_TL = 40_000_000
GEMINI_MODEL = 'gemini-2.5-flash'
MAX_BYTES = 2_000_000

class FeedError(Exception):
    pass

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward ingest credentials through a redirect.

OPENER = urllib.request.build_opener(NoRedirect)

def request_json(url, payload=None, headers=None, timeout=20, attempts=3):
    req = urllib.request.Request(url, data=None if payload is None else
        json.dumps(payload, separators=(',', ':'), allow_nan=False).encode(),
        headers={'User-Agent': 'BIST-Cloud-Bridge/1.0', 'Accept': 'application/json',
                 **(headers or {})}, method='GET' if payload is None else 'POST')
    for attempt in range(attempts):
        try:
            with OPENER.open(req, timeout=timeout) as response:
                raw = response.read(MAX_BYTES + 1)
                if len(raw) > MAX_BYTES:
                    raise FeedError('RESPONSE_TOO_LARGE')
                return json.loads(raw)
        except urllib.error.HTTPError as exc:
            code = exc.code
            exc.close()
            if code not in (429, 500, 502, 503, 504) or attempt == attempts-1:
                raise FeedError(f'HTTP_{code}') from None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, http.client.HTTPException):
            if attempt == attempts-1:
                raise FeedError('NETWORK_OR_BAD_JSON') from None
        time.sleep(5 * (attempt + 1))
    raise FeedError('RETRIES_EXHAUSTED')

def normalize(symbol, timestamp, values, now):
    # Timestamps are UTC bar START times. Only completed candles are sent.
    if not isinstance(timestamp, (int, float)) or not math.isfinite(timestamp):
        return None
    if timestamp % 900 != 0 or timestamp + 900 > now or timestamp < now - 7 * 86400:
        return None
    if len(values) != 5 or any(isinstance(v, bool) or not isinstance(v, (int, float))
                              or not math.isfinite(v) for v in values):
        return None
    o, h, l, c, v = values
    if min(o, h, l, c) <= 0 or v < 0 or not l <= min(o, c) <= max(o, c) <= h:
        return None
    return dict(symbol=symbol, interval='15m', time=dt.datetime.fromtimestamp(
        timestamp, UTC).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
        open=o, high=h, low=l, close=c, volume=v)

def yahoo(symbol, now):
    url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '.IS?' + \
        urllib.parse.urlencode({'interval': '15m', 'range': '5d', 'includePrePost': 'false'})
    data = request_json(url)
    chart = data.get('chart', {})
    result = chart.get('result') or []
    if chart.get('error') or not result:
        raise FeedError('YAHOO_NO_DATA')
    x = result[0]
    meta=x.get('meta',{})
    if meta.get('instrumentType')!='EQUITY':raise FeedError('YAHOO_NOT_EQUITY')
    if meta.get('currency')!='TRY':raise FeedError('YAHOO_CURRENCY_NOT_TRY')
    provider_time=meta.get('regularMarketTime')
    if not isinstance(provider_time,(int,float)) or not math.isfinite(provider_time):
        raise FeedError('YAHOO_PROVIDER_CLOCK_UNAVAILABLE')
    confirmed_now=min(now,provider_time)
    q = ((x.get('indicators') or {}).get('quote') or [{}])[0]
    bars = []
    for i, timestamp in enumerate(x.get('timestamp') or []):
        values = [(q.get(k) or [])[i] if i < len(q.get(k) or []) else None
                  for k in ('open', 'high', 'low', 'close', 'volume')]
        bar = normalize(symbol, timestamp, values, confirmed_now)
        if bar:
            bars.append(bar)
    if not bars:
        raise FeedError('YAHOO_NO_CLOSED_BARS')
    return sorted(bars, key=lambda b: b['time'])[-100:]

def twelve(symbol, now, key):
    # XIST is documented EOD: this fallback imports history, never marks it live.
    data = request_json('https://api.twelvedata.com/time_series?' +
        urllib.parse.urlencode({'symbol': symbol, 'exchange': 'BIST', 'interval': '15min',
                                'outputsize': 100, 'timezone': 'UTC'}),
        headers={'Authorization': 'apikey ' + key})
    if data.get('status') == 'error' or not data.get('values'):
        raise FeedError('TWELVE_ACCESS_OR_INTERVAL_UNAVAILABLE')
    bars = []
    for row in data['values']:
        try:
            stamp = dt.datetime.fromisoformat(row['datetime']).replace(tzinfo=UTC).timestamp()
            bar = normalize(symbol, stamp, [float(row[k]) for k in
                ('open', 'high', 'low', 'close', 'volume')], now)
            if bar:
                bars.append(bar)
        except (KeyError, ValueError, TypeError):
            continue
    if not bars:
        raise FeedError('TWELVE_NO_CLOSED_BARS')
    return sorted(bars, key=lambda b: b['time'])[-100:]

def stage_one(all_bars, eligible_symbols):
    if not all_bars:return pd.DataFrame()
    df=pd.DataFrame(all_bars).sort_values(['symbol','time']).drop_duplicates(['symbol','time'])
    prior=df.groupby('symbol')['volume'].transform(lambda x:x.shift(1).rolling(20,min_periods=20).mean())
    spread=df['high']-df['low']+1e-9
    df['rvol']=np.divide(df['volume'],prior.where(prior>0))
    df['body']=np.abs(df['close']-df['open'])/spread
    df['upper_wick']=(df['high']-df['close'])/spread
    local=pd.to_datetime(df['time'],utc=True).dt.tz_convert(TRT)
    minute=local.dt.hour*60+local.dt.minute
    df['session_date']=local.dt.strftime('%Y-%m-%d')
    df['turnover']=(df['close']*df['volume']).where((minute>=600)&(minute<1085),0)
    df['daily_turnover_tl_estimate']=df.groupby(['symbol','session_date'])['turnover'].cumsum()
    latest=df.groupby('symbol',sort=False).tail(1)
    mask=((latest.rvol>=2.0)&(latest.close>latest.open)&(latest.body>=.60)&
          (latest.upper_wick<=.20)&(latest.daily_turnover_tl_estimate>=MIN_DAILY_TURNOVER_TL)&latest.symbol.isin(eligible_symbols))
    return latest.loc[mask].copy()


def evaluate_with_gemini(symbol, metrics):
    """Structured, fail-closed numeric review; never prints SDK exceptions/keys."""
    key=os.environ.get('GEMINI_API_KEY','').strip()
    if not key:
        return {'approved':False,'confidence':0,'reason':'GEMINI_KEY_MISSING'},'ERROR'
    try:
        from google import genai
        schema={'type':'object','properties':{'approved':{'type':'boolean'},
                'confidence':{'type':'integer','minimum':0,'maximum':100},'reason':{'type':'string'}},
                'required':['approved','confidence','reason'],'additionalProperties':False}
        with genai.Client(api_key=key,http_options={'timeout':20000}) as client:
            res=client.models.generate_content(model=GEMINI_MODEL,
                contents='Sanal BIST teknik hakemisin. Sadece verilen verileri değerlendir. '+
                'RVOL>=2, yeşil mum, gövde>=0.60, üst fitil<=0.20, seans VWAP üstü, 20 bar kırılımı ve '+
                'kapanmış seans barlarından tahmini hacim>=40000000 TL gereklidir. Resmi VBTS uygun olmalı. '+
                'Eksik/tutarsız veride reddet. Haber veya wash trade yokluğu uydurma; dış arama yapma. '+
                'Güven başarı olasılığı değildir. PROBE yalnız bağlantı testidir, işlem onayı değildir. '+
                json.dumps({'symbol':symbol,'data':metrics},ensure_ascii=False,allow_nan=False),
                config={'response_mime_type':'application/json','response_json_schema':schema,
                        'temperature':0,'max_output_tokens':1024,'thinking_config':{'thinking_budget':0}})
        verdict=json.loads(res.text)
        if set(verdict)!= {'approved','confidence','reason'} or type(verdict['approved']) is not bool or \
            type(verdict['confidence']) is not int or not 0<=verdict['confidence']<=100 or \
            not isinstance(verdict['reason'],str) or not verdict['reason'].strip() or len(verdict['reason'])>1000:
            raise ValueError('INVALID_GEMINI_JSON')
        return verdict,'APPROVED' if verdict['approved'] else 'REJECTED'
    except Exception as exc:
        code=getattr(exc,'code',None)
        safe_code=str(code) if isinstance(code,int) else type(exc).__name__
        return {'approved':False,'confidence':0,'reason':'GEMINI_ERROR_'+safe_code},'ERROR'


def review_gemini(run_id, symbol=None, bar_time=None):
    query={'purpose':'PROBE'} if symbol is None else {'run_id':run_id,'symbol':symbol,'bar_time':bar_time}
    state=worker_call('/bist/feed/gemini?'+urllib.parse.urlencode(query))
    if state.get('cached',{} ) and state['cached']['status']!='ERROR':
        return state['cached']['status']
    verdict,status=evaluate_with_gemini(symbol or 'PROBE',state.get('candidate') or {'purpose':'PROBE'})
    worker_call('/bist/feed/gemini',{**query,'model':GEMINI_MODEL,'status':status,'verdict':verdict})
    print('GEMINI',symbol or 'PROBE',status,verdict['reason'] if status=='ERROR' else '')
    return status


def worker_config():
    base=os.environ.get('BIST_WORKER_URL','').rstrip('/')
    token=os.environ.get('BIST_INGEST_TOKEN','')
    parsed=urllib.parse.urlsplit(base)
    if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or not token:
        raise FeedError('CONFIGURE_BIST_WORKER_URL_AND_BIST_INGEST_TOKEN')
    return base,token


def worker_call(path,body=None):
    base,token=worker_config()
    return request_json(base+path,body,{'Authorization':'Bearer '+token,'Content-Type':'application/json'},timeout=1800 if path.endswith('/finalize') else 20)


def main():
    if '--probe' in sys.argv:
        probe=worker_call('/bist/feed/probe',{})
        print('MINI_PROBE',probe)
        return 1 if probe.get('status')=='ERROR' else 0
    if '--prepare' in sys.argv:
        universe = restrict_universe(load_universe())
        worker_call('/bist/feed/risk', {'symbols':universe['symbols'],'eligible_symbols':universe['eligible_symbols'],
                    'risk':universe.get('risk'), 'risk_status':universe['risk_status']})
        output = os.environ.get('GITHUB_OUTPUT')
        if not output:
            raise FeedError('GITHUB_OUTPUT_REQUIRED')
        with open(output, 'a') as stream:
            stream.write('universe=' + json.dumps(universe, separators=(',', ':')) + '\n')
        print('MINI_PROBE',worker_call('/bist/feed/probe',{}))
        review_gemini('PROBE')
        print('UNIVERSE symbols=',len(universe['symbols']),'eligible=',len(universe['eligible_symbols']),'risk=',universe['risk_status'])
        return 0
    run_id=os.environ.get('BIST_RUN_ID') or dt.datetime.now(UTC).strftime('%Y%m%dT%H%M')
    if '--finalize' in sys.argv:
        print('FINALIZE',worker_call('/bist/feed/finalize',{'run_id':run_id}))
        return 0
    raw_universe=os.environ.get('BIST_UNIVERSE_JSON')
    universe=json.loads(raw_universe) if raw_universe else restrict_universe(load_universe())
    all_symbols=sorted(set(universe.get('symbols',[])))
    if len(all_symbols)<400 or any(not re.fullmatch(r'[A-Z0-9]{3,6}',x) for x in all_symbols):
        raise FeedError('INVALID_BIST_UNIVERSE')
    eligible=set(universe.get('eligible_symbols',[]))
    monitors=set(worker_call('/bist/feed/monitor').get('symbols',[]))
    shard=int(os.environ.get('BIST_SHARD_INDEX','0'));shards=int(os.environ.get('BIST_SHARD_COUNT','1'))
    symbols=partition(sorted(eligible|monitors),shard,shards)
    print(f'SCOPE total={len(all_symbols)} eligible={len(eligible)} shard={shard}/{shards} assigned={len(symbols)}')
    worker_config()
    now=time.time(); local=dt.datetime.fromtimestamp(now,ZoneInfo('Europe/Istanbul'))
    if os.environ.get('GITHUB_EVENT_NAME')=='schedule' and (local.weekday()>=5 or not 600<=local.hour*60+local.minute<=1085):
        print('SKIPPED_OUTSIDE_SESSION');return 0
    key = os.environ.get('TWELVE_DATA_API_KEY', '')
    fallback_count = 0
    last_twelve = 0.0
    fetched={};errors=0
    for symbol in symbols:
        try:
            try:
                bars=yahoo(symbol,time.time());source='YAHOO_INDICATIVE';feed_type='INDICATIVE_INTRADAY'
            except FeedError:
                if not key or shard!=0 or fallback_count>=6:raise FeedError('YAHOO_UNAVAILABLE_NO_USABLE_FALLBACK') from None
                time.sleep(max(0,12-(time.monotonic()-last_twelve)));last_twelve=time.monotonic();fallback_count+=1
                bars=twelve(symbol,time.time(),key);source='TWELVE_DATA_XIST_EOD';feed_type='EOD'
            fetched[symbol]={'bars':bars,'source':source,'feed_type':feed_type}
            # Close/entry monitoring cannot depend on whether today's candle stays hot.
            if symbol in monitors:
                worker_call('/bist/feed/ingest',{**fetched[symbol],'run_id':run_id,'purpose':'MONITOR'})
        except FeedError as exc:
            errors+=1;print(symbol,str(exc))
        time.sleep(3)
    hot=stage_one([b for x in fetched.values() if x['feed_type']=='INDICATIVE_INTRADAY' for b in x['bars']],eligible)
    hot_symbols=set(hot.symbol) if not hot.empty else set()
    posted=0;gemini_candidates=[]
    for symbol in sorted(hot_symbols):
        try:
            result=worker_call('/bist/feed/ingest',{**fetched[symbol],'run_id':run_id,'purpose':'HOT_CANDIDATE'})
            posted+=1;print(symbol,'stage2=',result.get('stage2'),'engine=',result.get('engine'))
            if result.get('stage2')=='MOMENTUM_PASSED':
                gemini_candidates.append((symbol,result['bar_time']))
        except FeedError as exc:errors+=1;print(symbol,str(exc))
    # Four simultaneous requests throttle transport; the entire pool is reviewed, with no count cap.
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures={pool.submit(review_gemini,run_id,symbol,bar_time):symbol for symbol,bar_time in gemini_candidates}
        for future in as_completed(futures):
            try:future.result()
            except FeedError as exc:errors+=1;print(futures[future],str(exc))
    latest=max((x['bars'][-1]['time'] for x in fetched.values() if x['feed_type']=='INDICATIVE_INTRADAY'),default=None)
    report={'run_id':run_id,'shard':shard,'universe_total':len(all_symbols),'eligible_total':len(eligible),
            'assigned':len(symbols),'fetched':len(fetched),'hot':len(hot_symbols),'posted':posted,'errors':errors,'last_bar_time':latest}
    worker_call('/bist/feed/report',report)
    print('SUMMARY',report)
    if not eligible:print('BLOCKED_RESTRICTIONS_UNAVAILABLE: monitoring only')
    # A zero-hot scan is a normal outcome. Do not force candidate/trade counts.
    return 0 if fetched or not symbols else 1

if __name__ == '__main__':
    try:
        sys.exit(main())
    except FeedError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
