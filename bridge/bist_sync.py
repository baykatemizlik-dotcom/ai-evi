#!/usr/bin/env python3
"""Standard-library cloud bridge. Never prints keys or provider response bodies."""
import datetime as dt
import hashlib
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

# Pilot watchlist, NOT a claim of current official index/market membership.
SYMBOLS = ('THYAO', 'TUPRS', 'ASELS', 'EREGL', 'AKBNK', 'GARAN', 'ISCTR',
           'YKBNK', 'BIMAS', 'KCHOL', 'SAHOL', 'SISE', 'TCELL', 'TTKOM',
           'FROTO', 'TOASO', 'ENKAI', 'PETKM', 'PGSUS', 'SASA')
UTC = dt.timezone.utc
MAX_BYTES = 2_000_000

class FeedError(Exception):
    pass

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward ingest credentials through a redirect.

OPENER = urllib.request.build_opener(NoRedirect)

def request_json(url, payload=None, headers=None):
    req = urllib.request.Request(url, data=None if payload is None else
        json.dumps(payload, separators=(',', ':'), allow_nan=False).encode(),
        headers={'User-Agent': 'BIST-Cloud-Bridge/1.0', 'Accept': 'application/json',
                 **(headers or {})}, method='GET' if payload is None else 'POST')
    for attempt in range(3):
        try:
            with OPENER.open(req, timeout=20) as response:
                raw = response.read(MAX_BYTES + 1)
                if len(raw) > MAX_BYTES:
                    raise FeedError('RESPONSE_TOO_LARGE')
                return json.loads(raw)
        except urllib.error.HTTPError as exc:
            code = exc.code
            exc.close()
            if code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise FeedError(f'HTTP_{code}') from None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            if attempt == 2:
                raise FeedError('NETWORK_OR_BAD_JSON') from None
        time.sleep(5 * (attempt + 1))
    raise FeedError('RETRIES_EXHAUSTED')

def normalize(symbol, timestamp, values, now):
    # Timestamps are UTC bar START times. Only completed candles are sent.
    if not isinstance(timestamp, (int, float)) or not math.isfinite(timestamp):
        return None
    if timestamp + 900 > now or timestamp < now - 7 * 86400:
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
    q = ((x.get('indicators') or {}).get('quote') or [{}])[0]
    bars = []
    for i, timestamp in enumerate(x.get('timestamp') or []):
        values = [(q.get(k) or [])[i] if i < len(q.get(k) or []) else None
                  for k in ('open', 'high', 'low', 'close', 'volume')]
        bar = normalize(symbol, timestamp, values, now)
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

def main():
    base = os.environ.get('BIST_WORKER_URL', '').rstrip('/')
    token = os.environ.get('BIST_INGEST_TOKEN', '')
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or \
            parsed.password or parsed.query or parsed.fragment or not token:
        raise FeedError('CONFIGURE_BIST_WORKER_URL_AND_BIST_INGEST_TOKEN')
    now = time.time()
    local = dt.datetime.fromtimestamp(now, ZoneInfo('Europe/Istanbul'))
    minutes = local.hour * 60 + local.minute
    if os.environ.get('GITHUB_EVENT_NAME') == 'schedule' and \
            (local.weekday() >= 5 or not 600 <= minutes <= 1100):
        print('SKIPPED_OUTSIDE_SESSION')
        return 0
    key = os.environ.get('TWELVE_DATA_API_KEY', '')
    fallback_count = 0
    last_twelve = 0.0
    active = 0
    imported = 0
    for symbol in SYMBOLS:
        try:
            try:
                bars = yahoo(symbol, time.time())
                source = 'YAHOO_INDICATIVE'
                feed_type = 'INDICATIVE_INTRADAY'
            except FeedError:
                # <= 6 requests/run; 34 scheduled runs/day => <=204 fallback credits.
                if not key or fallback_count >= 6:
                    raise FeedError('YAHOO_UNAVAILABLE_NO_USABLE_FALLBACK') from None
                time.sleep(max(0, 12 - (time.monotonic() - last_twelve)))
                last_twelve = time.monotonic()
                fallback_count += 1
                bars = twelve(symbol, time.time(), key)
                source = 'TWELVE_DATA_XIST_EOD'
                feed_type = 'EOD'
            body = {'source': source, 'feed_type': feed_type, 'bars': bars}
            body['batch_id'] = hashlib.sha256(json.dumps(body, sort_keys=True,
                separators=(',', ':')).encode()).hexdigest()
            result = request_json(base + '/bist/feed/ingest', body,
                {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
            if not result.get('ok'):
                raise FeedError('INGEST_NOT_ACCEPTED')
            imported += 1
            active += result.get('status') == 'ACTIVE'
            print(symbol, 'accepted=', result.get('bar_rows'),
                  'state=', result.get('status'), 'paper=', result.get('engine'))
        except FeedError as exc:
            print(symbol, str(exc))
        time.sleep(3)
    print(f'SUMMARY imported_symbols={imported} active_symbols={active}')
    # Historical data alone must not pass an intraday scan as healthy.
    return 0 if active else 1

if __name__ == '__main__':
    try:
        sys.exit(main())
    except FeedError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
