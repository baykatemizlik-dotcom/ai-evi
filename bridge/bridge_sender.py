#!/usr/bin/env python3
"""BIST AVCI authorized OHLCV bridge sender (Python stdlib only).

Configuration (environment, no secrets in Git):
  BIST_FEED_URL: HTTPS JSON feed controlled/authorized by your data provider
  BIST_WORKER_URL: https://ai-evi.baykatemizlik.workers.dev
  BIST_ACCESS_TOKEN: Worker ACCESS_TOKEN, kept exclusively server-side

Feed response JSON:
  {"source":"licensed-provider","universe":[{"symbol":"THYAO","market":"YILDIZ","liquidity_tl":75000000}],
   "bars":[{"symbol":"THYAO","interval":"15m","time":"2026-10-09T07:00:00Z",
   "open":100.0,"high":102.0,"low":99.0,"close":101.0,"volume":123456}]}
These are schema examples, never sample live prices.
"""
import json, os, sys, time, urllib.request
from urllib.parse import urlparse

def request(url, method="GET", payload=None, token=None):
    if urlparse(url).scheme != "https":
        raise ValueError("HTTPS required")
    data = None if payload is None else json.dumps(payload,separators=(",",":")).encode()
    headers = {"Accept":"application/json","User-Agent":"BIST-AVCI-AuthorizedBridge/1.0"}
    if data is not None: headers["Content-Type"]="application/json"
    if token: headers["Authorization"]="Bearer "+token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=25) as r:
        raw = r.read(3_000_001)
        if len(raw)>3_000_000: raise ValueError("response too large")
        return json.loads(raw)

def main():
    feed=os.environ.get("BIST_FEED_URL","")
    worker=os.environ.get("BIST_WORKER_URL","https://ai-evi.baykatemizlik.workers.dev").rstrip("/")
    token=os.environ.get("BIST_ACCESS_TOKEN","")
    if not feed or not token:
        raise SystemExit("BLOCKED: configure BIST_FEED_URL and BIST_ACCESS_TOKEN in server environment")
    if urlparse(feed).scheme!="https": raise SystemExit("BLOCKED: feed must use HTTPS")
    doc=request(feed)
    if not isinstance(doc,dict) or not isinstance(doc.get("universe"),list) or not isinstance(doc.get("bars"),list):
        raise ValueError("feed must contain universe and bars arrays")
    symbols=doc["universe"]
    bars=doc["bars"]
    source=doc.get("source","authorized-feed")
    count=0
    # Import in small bounded batches. No fake fallback data.
    for i in range(0,max(len(symbols),len(bars)),100):
        item={"source":source,"universe":symbols[i:i+100],"bars":bars[i:i+100]}
        res=request(worker+"/bist/bridge/import",method="POST",payload=item,token=token)
        if not res.get("ok"): raise RuntimeError("Worker bridge rejected payload")
        count += len(item["bars"])
    print(json.dumps({"ok":True,"universe":len(symbols),"bars_imported":count},ensure_ascii=False))

if __name__=="__main__":
    try:main()
    except Exception as e:
        print(json.dumps({"ok":False,"error":str(e)[:220]},ensure_ascii=False),file=sys.stderr)
        sys.exit(1)
