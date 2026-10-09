#!/usr/bin/env python3
"""Best-effort, LOCAL Yahoo chart bridge for BIST AVCI. No IP/cookie evasion.
Requires an independently VERIFIED universe CSV and valid source permissions.
Never sends real orders; never invents candles.
"""
import csv,datetime as dt,json,os,sys,time,urllib.parse,urllib.request,urllib.error
from pathlib import Path

BASE=os.getenv("BIST_WORKER_URL","https://ai-evi.baykatemizlik.workers.dev").rstrip("/")
TOKEN=os.getenv("BIST_ACCESS_TOKEN","")
UNIVERSE=Path(os.getenv("BIST_UNIVERSE_CSV","universe.csv"))
SLEEP=float(os.getenv("BIST_REQUEST_GAP_SECONDS","3"))
MAX=int(os.getenv("BIST_MAX_SYMBOLS_PER_RUN","20"))
def http(url,body=None,token=None):
    headers={"Accept":"application/json","User-Agent":"BIST-AVCI-LocalBridge/1.0"}
    if body is not None:headers["Content-Type"]="application/json"
    if token:headers["Authorization"]="Bearer "+token
    req=urllib.request.Request(url,data=json.dumps(body).encode() if body is not None else None,headers=headers,method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req,timeout=20) as response:return json.load(response)
def universe():
    if not UNIVERSE.exists():raise RuntimeError("MISSING_VERIFIED_UNIVERSE_CSV")
    result=[]
    with UNIVERSE.open(encoding="utf-8-sig",newline="") as file:
        for r in csv.DictReader(file):
            symbol=r.get("symbol","").strip().upper()
            market=r.get("market","").strip().upper()
            try:liquidity=float(r.get("liquidity_tl",""))
            except ValueError:continue
            if symbol.isascii() and symbol.isalnum() and 3<=len(symbol)<=7 and market in ("ANA","YILDIZ") and liquidity>30_000_000:
                result.append(dict(symbol=symbol,market=market,liquidity_tl=liquidity))
    if not result:raise RuntimeError("NO_VERIFIED_LIQUID_SYMBOLS")
    return result[:min(MAX,1000)]
def candles(symbol,period,interval):
    path=urllib.parse.quote(symbol+".IS",safe="")
    query=urllib.parse.urlencode({"range":period,"interval":interval})
    data=http("https://query1.finance.yahoo.com/v8/finance/chart/"+path+"?"+query)
    result=(data.get("chart") or {}).get("result") or []
    if not result:raise RuntimeError("EMPTY_YAHOO_CHART")
    item=result[0];times=item.get("timestamp") or []
    q=(((item.get("indicators") or {}).get("quote")) or [{}])[0]
    bars=[]
    step=900 if interval=="15m" else 86400
    for i,t in enumerate(times):
        try:
            o,h,l,c,v=[q[k][i] for k in ("open","high","low","close","volume")]
            if any(x is None for x in (o,h,l,c,v)):continue
            if not (0<l<=min(o,c) and max(o,c)<=h and v>=0):continue
            # Never ingest still-open 15min bars or the unfinished local day.
            timestamp=dt.datetime.fromtimestamp(int(t),dt.timezone.utc)
            if interval=="15m" and time.time()<int(t)+step+120:continue
            if interval=="1d" and timestamp.astimezone(dt.timezone(dt.timedelta(hours=3))).date()==dt.datetime.now(dt.timezone(dt.timedelta(hours=3))).date():continue
            bars.append({"symbol":symbol,"interval":"15m" if interval=="15m" else "1d","time":timestamp.isoformat().replace("+00:00","Z"),"open":float(o),"high":float(h),"low":float(l),"close":float(c),"volume":float(v)})
        except (IndexError,TypeError,ValueError,KeyError):continue
    return bars[-90:]
def push(universe_rows, bars):
    for i in range(0,max(len(universe_rows),len(bars)),100):
        response=http(BASE+"/bist/feed/ingest",{"source":"local-yahoo-unverified","universe":universe_rows[i:i+100],"bars":bars[i:i+100]},TOKEN)
        if not response.get("ok"):raise RuntimeError("INGEST_REJECTED")
def main():
    if not TOKEN:raise RuntimeError("BIST_ACCESS_TOKEN_MISSING")
    if not BASE.startswith("https://"):raise RuntimeError("HTTPS_REQUIRED")
    rows=universe();total=0;failed=[]
    for r in rows:
        sym=r["symbol"];allbars=[]
        for period,interval in (("60d","15m"),("3mo","1d")):
            try:allbars.extend(candles(sym,period,interval))
            except urllib.error.HTTPError as e:
                if e.code in (429,403):raise RuntimeError("YAHOO_ACCESS_DENIED_"+str(e.code))
                failed.append(sym+":"+str(e.code))
            except Exception as e:failed.append(sym+":"+str(e)[:50])
            time.sleep(max(1,SLEEP))
        if allbars:
            push([r],allbars);total+=len(allbars)
    print(json.dumps({"symbols_attempted":len(rows),"bars_sent":total,"errors":failed[:20]},ensure_ascii=False))
if __name__=="__main__":
    try:main()
    except Exception as e:print("BLOCKED:",str(e),file=sys.stderr);sys.exit(1)
