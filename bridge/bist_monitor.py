#!/usr/bin/env python3
"""Poll only live positions and approved pending candidates; never call AI."""
import datetime as dt
import re
import sys
import time
from zoneinfo import ZoneInfo
import bist_sync as feed

def session_open(now):
    local = dt.datetime.fromtimestamp(now, ZoneInfo("Europe/Istanbul"))
    return local.weekday() < 5 and 600 <= local.hour * 60 + local.minute <= 1085

def poll_once():
    if not session_open(time.time()):
        print("MONITOR_OUTSIDE_SESSION")
        return 0
    feed.worker_config()
    symbols = sorted(set(feed.worker_call("/bist/feed/monitor").get("symbols", [])))
    if any(not isinstance(s, str) or not re.fullmatch(r"[A-Z0-9]{3,6}", s) for s in symbols):
        raise feed.FeedError("INVALID_MONITOR_SYMBOL")
    errors = 0
    for symbol in symbols:
        try:
            bars = feed.yahoo(symbol, time.time())
            result = feed.worker_call("/bist/feed/ingest", {
                "bars": bars, "source": "YAHOO_INDICATIVE",
                "feed_type": "INDICATIVE_INTRADAY", "purpose": "MONITOR"})
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
