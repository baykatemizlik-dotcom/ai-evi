#!/usr/bin/env python3
"""Independent 60m/daily trend scanner. Only paper ingress, no scalp AI decisions."""
import datetime as dt
import math
import re
import sys
import time
import urllib.parse
from zoneinfo import ZoneInfo
import bist_sync as feed

def trend_history(symbol,interval,now):
    if not re.fullmatch(r'[A-Z0-9]{3,6}',symbol) or interval not in ('60m','1d'):
        raise feed.FeedError('INVALID_TREND_REQUEST')
    params={'interval':interval,'period1':int(now-700*86400),'period2':int(now),'includePrePost':'false'}
    x=(feed.request_json('https://query1.finance.yahoo.com/v8/finance/chart/'+symbol+'.IS?'+urllib.parse.urlencode(params)).get('chart') or {}).get('result') or []
    if not x:raise feed.FeedError('TREND_NO_DATA')
    x=x[0];meta=x.get('meta',{})
    if meta.get('currency')!='TRY' or meta.get('instrumentType')!='EQUITY':raise feed.FeedError('TREND_NOT_TRY_EQUITY')
    provider=meta.get('regularMarketTime')
    if not isinstance(provider,(int,float)) or isinstance(provider,bool) or not math.isfinite(provider):raise feed.FeedError('TREND_PROVIDER_CLOCK_MISSING')
    confirmed=min(provider,now);quotes=((x.get('indicators') or {}).get('quote') or [{}])[0];out=[]
    today=dt.datetime.fromtimestamp(now,ZoneInfo('Europe/Istanbul')).date()
    for i,t in enumerate(x.get('timestamp') or []):
        values=[(quotes.get(k) or [])[i] if i<len(quotes.get(k) or []) else None for k in ('open','high','low','close','volume')]
        if not isinstance(t,(int,float)) or isinstance(t,bool) or not math.isfinite(t) or t>confirmed:continue
        if interval=='60m' and (t%3600 not in (0,1800) or t+3600>confirmed):continue
        if interval=='1d' and dt.datetime.fromtimestamp(t,ZoneInfo('Europe/Istanbul')).date()>=today:continue
        if any(not isinstance(v,(int,float)) or isinstance(v,bool) or not math.isfinite(v) for v in values):continue
        o,h,l,c,v=values
        if min(o,h,l,c)<=0 or v<0 or l>min(o,c) or h<max(o,c):continue
        out.append({'time':dt.datetime.fromtimestamp(t,feed.UTC).isoformat(timespec='milliseconds').replace('+00:00','Z'),'open':o,'high':h,'low':l,'close':c,'volume':v})
    out=sorted({b['time']:b for b in out}.values(),key=lambda b:b['time'])[-350:]
    if len(out)<200:raise feed.FeedError('TREND_EMA200_HISTORY_MISSING')
    return out

def main():
    from bist_universe import partition
    feed.worker_config();state=feed.worker_call('/bist/feed/trend-universe')
    shard=int(sys.argv[sys.argv.index('--shard')+1]) if '--shard' in sys.argv else 0
    priority=set(state.get('priority',[]));symbols=partition(state.get('symbols',[]),shard,8)
    symbols=sorted(symbols,key=lambda s:(s not in priority,s));errors=0;fetched=0
    for symbol in symbols:
        try:
            packet=feed.yahoo(symbol,time.time(),with_quote=True)
            feed.worker_call('/bist/feed/ingest',{**packet,'purpose':'MONITOR'})
            hour=trend_history(symbol,'60m',time.time());daily=trend_history(symbol,'1d',time.time())
            result=feed.worker_call('/bist/feed/trend',{'symbol':symbol,'source':'YAHOO_INDICATIVE','hour':hour,'daily':daily,'quote':packet['quote']})
            fetched+=1;print('TREND_SCAN',symbol,'criteria=',result.get('criteria_passed'),'queued=',result.get('queued'),flush=True)
        except feed.FeedError as exc:errors+=1;print('TREND_FEED_ERROR',symbol,str(exc),flush=True)
        time.sleep(3)
    print('TREND_SCAN_SUMMARY',{'shard':shard,'fetched':fetched,'errors':errors},flush=True)
    return 0 if fetched or not symbols else 1
if __name__=='__main__':
    try:sys.exit(main())
    except feed.FeedError as exc:print(str(exc),file=sys.stderr);sys.exit(1)
