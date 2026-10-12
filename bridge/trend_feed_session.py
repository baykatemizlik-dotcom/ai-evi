"""Bounded eight-shard orchestration for the unchanged Yahoo trend scanner."""
import datetime as dt
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
DURATION = 25 * 60
INTERVAL = 5 * 60


def market_window(epoch):
    local = dt.datetime.fromtimestamp(epoch, ZoneInfo('Europe/Istanbul'))
    return local.weekday() < 5 and 600 <= local.hour * 60 + local.minute < 1090


def scan_cycle(cycle, run=subprocess.run):
    def shard(index):
        try:
            return run([sys.executable, '-u', str(ROOT / 'bist_trend.py'),
                        '--shard', str(index)], timeout=14 * 60, check=False).returncode
        except subprocess.TimeoutExpired:
            return 124
    with ThreadPoolExecutor(max_workers=8) as pool:
        codes = list(pool.map(shard, range(8)))
    print(json.dumps({'event': 'TREND_CYCLE_END', 'cycle': cycle,
                      'shard_returncodes': codes}), flush=True)
    return codes


def run_session(clock=time.time, sleep=time.sleep, scan=scan_cycle):
    began = clock()
    cycle = 0
    while market_window(clock()) and clock() - began < DURATION:
        start = clock()
        cycle += 1
        print(json.dumps({'event': 'TREND_CYCLE_START', 'cycle': cycle,
                          'epoch': start, 'interval_seconds': INTERVAL}), flush=True)
        scan(cycle)
        end = clock()
        if end - began >= DURATION:
            break
        delay = min(max(0, INTERVAL - (end - start)), DURATION - (end - began))
        sleep(delay)
    print(json.dumps({'event': 'TREND_SESSION_END', 'cycles': cycle}), flush=True)


def handoff():
    # Reuse the tested credential-safe dispatcher, but constrain the window here.
    if not market_window(time.time()):
        print('TREND_HANDOFF_OUTSIDE_SESSION')
        return
    from trial_session import handoff as dispatch
    dispatch('bist_trend.yml')


if __name__ == '__main__':
    if '--handoff' in sys.argv:
        handoff()
    else:
        run_session()
