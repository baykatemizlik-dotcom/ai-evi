#!/usr/bin/env python3
"""Poll only live positions and approved pending candidates; never call AI."""
import datetime as dt
import re
import sys
import time
from zoneinfo import ZoneInfo
import bist_sync as feed
from bist_trend import trend_history

def session_open(now):
    local = dt.datetime.fromtimestamp(now, ZoneInfo("Europe/Istanbul"))
    return local.weekday() < 5 and 600 <= local.hour * 60 + local.minute <= 1085

def poll_once():
    if not session_open(time.time()):
        print("MONITOR_OUTSIDE_SESSION")
        return 0
    feed.worker_config()
    state=feed.worker_call("/bist/feed/monitor")
    symbols = sorted(set(state.get("symbols", [])))
    trend_symbols={x["symbol"] for x in state.get("targets",[]) if x.get("strategy")=="SWING"}
    if any(not isinstance(s, str) or not re.fullmatch(r"[A-Z0-9]{3,6}", s) for s in symbols):
        raise feed.FeedError("INVALID_MONITOR_SYMBOL")
    errors = 0
    for symbol in symbols:
        try:
            packet = feed.yahoo(symbol, time.time(),with_quote=True)
            result = feed.worker_call("/bist/feed/ingest", {
                **packet, "purpose": "MONITOR"})
            if symbol in trend_symbols:
                hourly=trend_history(symbol,'60m',time.time())
                daily=trend_history(symbol,'1d',time.time())
                feed.worker_call('/bist/feed/trend',{'symbol':symbol,'source':'YAHOO_INDICATIVE','quote':packet['quote'],'hour':hourly,'daily':daily})
            print("TARGET_MONITOR", symbol, "bar=", result.get("bar_time"),
                  "status=", result.get("status"), "scalp=", result.get("engine"),
                  "sniper=", result.get("sniper"), flush=True)
        except feed.FeedError as exc:
            errors += 1
            print("TARGET_MONITOR_ERROR", symbol, str(exc), flush=True)
        time.sleep(3)
    print("TARGET_MONITOR_SUMMARY", "symbols=", len(symbols), "errors=", errors, flush=True)
    return errors

def main():
    errors = 0
    for cycle in range(5 if "--watch" in sys.argv else 1):
        if not session_open(time.time()):
            break
        start = time.monotonic()
        errors += poll_once()
        if "--watch" in sys.argv and cycle < 4:
            time.sleep(max(0, 60 - (time.monotonic() - start)))
    return 1 if errors else 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except feed.FeedError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
