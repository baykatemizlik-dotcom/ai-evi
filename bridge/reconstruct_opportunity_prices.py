"""Read-only Yahoo reconstruction; never changes trades, quotes or signal timestamps."""
import argparse, concurrent.futures, datetime as dt, json, math, sqlite3, urllib.parse
from pathlib import Path
from bist_sync import request_json

def iso(t):
    return dt.datetime.fromtimestamp(t,dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')

def chart(symbol, interval, now):
    data=request_json('https://query1.finance.yahoo.com/v8/finance/chart/'+symbol+'.IS?'+urllib.parse.urlencode({'interval':interval,'range':'5d','includePrePost':'false'}),attempts=2)
    result=(data.get('chart') or {}).get('result') or []
    if not result: raise ValueError('YAHOO_EMPTY')
    r=result[0];q=r['indicators']['quote'][0];seconds={'1m':60,'15m':900,'60m':3600}[interval]
    rows=[]
    for i,t in enumerate(r.get('timestamp',[])):
        v={k:q.get(k,[])[i] for k in ['open','high','low','close','volume']}
        if t+seconds>now or not all(isinstance(x,(int,float)) and math.isfinite(x) for x in v.values()) or min(v[k] for k in ['open','high','low','close'])<=0:continue
        rows.append({'bar_time':iso(t),'interval':interval,**v})
    return rows

def main():
    p=argparse.ArgumentParser();p.add_argument('--database',required=True);p.add_argument('--date',required=True);p.add_argument('--output',required=True);a=p.parse_args()
    db=sqlite3.connect('file:'+a.database+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
    start=(dt.datetime.fromisoformat(a.date).replace(tzinfo=dt.timezone(dt.timedelta(hours=3)))).timestamp()
    events=[dict(r) for r in db.execute('SELECT * FROM opportunity_events WHERE captured_at>=? AND captured_at<?',(iso(start),iso(start+86400)))]
    now=dt.datetime.now(dt.timezone.utc).timestamp();retrieved=iso(now);results={};errors={}
    def fetch(s):
        return s,{i:chart(s,i,now) for i in ['1m','15m','60m']}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures={pool.submit(fetch,s):s for s in sorted(set(e['symbol'] for e in events))}
        for f in concurrent.futures.as_completed(futures):
            try:s,b=f.result();results[s]=b
            except Exception as e:errors[futures[f]]=str(e)
    reconstructed={}
    for e in events:
        at=dt.datetime.fromisoformat(e['captured_at'].replace('Z','+00:00')).timestamp()
        minute=next((b for b in results.get(e['symbol'],{}).get('1m',[]) if at<=dt.datetime.fromisoformat(b['bar_time'].replace('Z','+00:00')).timestamp()<=at+120),None)
        if minute:reconstructed[e['event_key']]={'price':minute['open'],'bar_time':minute['bar_time'],'retrieved_at':retrieved,'interval':'1m','source':'YAHOO_HISTORICAL_NEXT_MINUTE_OPEN'}
    payload={'trt_date':a.date,'retrieved_at':retrieved,'entries':reconstructed,'history':results,'errors':errors,'notice':'Retrospective reconstruction. Original quote availability and historical spread are unknown; not actual fills.'}
    Path(a.output).write_text(json.dumps(payload,ensure_ascii=False,allow_nan=False))
    print(json.dumps({'events':len(events),'reconstructed':len(reconstructed),'symbols':len(results),'errors':errors}))

if __name__=='__main__':main()
