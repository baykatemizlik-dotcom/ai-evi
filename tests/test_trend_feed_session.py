import datetime as dt
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
import trend_feed_session as session


class TrendSessions(unittest.TestCase):
    def test_session_boundaries(self):
        epoch = lambda s: dt.datetime.fromisoformat(s).timestamp()
        self.assertTrue(session.market_window(epoch('2026-10-12T10:00:00+03:00')))
        for stamp in ['2026-10-12T09:59:00+03:00', '2026-10-12T18:10:00+03:00',
                      '2026-10-11T11:00:00+03:00']:
            self.assertFalse(session.market_window(epoch(stamp)))

    def test_partial_failure_retries_next_cycle_without_overlap(self):
        clock = [dt.datetime.fromisoformat('2026-10-12T11:00:00+03:00').timestamp()]
        starts = []
        def scan(cycle):
            starts.append(clock[0])
            clock[0] += 20
            return [1, 0, 0, 0, 0, 0, 0, 0]
        session.run_session(clock=lambda: clock[0],
                            sleep=lambda n: clock.__setitem__(0, clock[0] + n), scan=scan)
        self.assertEqual(len(starts), 5)
        self.assertTrue(all(b - a == 300 for a, b in zip(starts, starts[1:])))

    def test_eight_original_shards_and_timeout_isolation(self):
        calls = []
        def run(args, **kwargs):
            index = int(args[-1])
            calls.append(index)
            if index == 2:
                import subprocess
                raise subprocess.TimeoutExpired(args, 840)
            return SimpleNamespace(returncode=0)
        self.assertEqual(session.scan_cycle(1, run), [0, 0, 124, 0, 0, 0, 0, 0])
        self.assertEqual(sorted(calls), list(range(8)))

    def test_only_same_workflow_handoff(self):
        epoch = dt.datetime.fromisoformat('2026-10-12T11:00:00+03:00').timestamp()
        with patch.object(session.time, 'time', return_value=epoch), patch('trial_session.handoff') as call:
            session.handoff()
            call.assert_called_once_with('bist_trend.yml')


if __name__ == '__main__':
    unittest.main()
