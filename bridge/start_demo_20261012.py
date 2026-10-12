"""One-time, user-authorised 25k PAPER epoch setup using configured ingest auth."""
import json
from bist_sync import worker_call

result = worker_call('/bist/demo/start-20261012', {
    'total_capital': 25000,
    'confirmation': 'ARCHIVE_OLD_DEMO_AND_RESET_20261012',
})
print('DEMO_START', json.dumps(result))
overview = worker_call('/bist/overview')
summary = {key: overview.get(key) for key in
           ['total_capital', 'scalp_cash', 'swing_cash', 'equity', 'realised_pnl', 'pending_entries', 'status', 'scanner_live', 'server_time']}
summary['open_positions'] = len(overview.get('open_trades', []))
print('DEMO_VERIFIED', json.dumps(summary))
assert result.get('ok') is True
assert summary['total_capital'] == 25000
assert summary['scalp_cash'] == 12500 and summary['swing_cash'] == 12500
assert summary['open_positions'] == 0 and summary['realised_pnl'] == 0
