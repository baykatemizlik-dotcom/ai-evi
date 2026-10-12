"""Read-only live connectivity probe; never submits bars, orders or AI probes."""
import json
import time
from bist_sync import worker_call, yahoo, FeedError

def main():
    failed = False
    for path in ['/bist/status', '/bist/connections', '/bist/feed/monitor']:
        try:
            result = worker_call(path)
            print(json.dumps({'endpoint': path, 'reachable': True,
                              'status': result.get('status'),
                              'scanner_live': result.get('scanner_live'),
                              'server_time': result.get('server_time')}, ensure_ascii=False))
        except FeedError as exc:
            failed = True
            print(json.dumps({'endpoint': path, 'reachable': False, 'error': str(exc)}))
    try:
        packet = yahoo('THYAO', time.time(), with_quote=True)
        print(json.dumps({'provider': 'YAHOO_INDICATIVE', 'reachable': True,
                          'closed_bars': len(packet['bars']),
                          'latest_bar': packet['bars'][-1]['time'] if packet['bars'] else None,
                          'quote_time': (packet.get('quote') or {}).get('quote_time'),
                          'note': 'Connectivity only; stale/off-session data cannot enable entries.'}))
    except FeedError as exc:
        failed = True
        print(json.dumps({'provider': 'YAHOO_INDICATIVE', 'reachable': False, 'error': str(exc)}))
    return int(failed)

if __name__ == '__main__':
    raise SystemExit(main())
