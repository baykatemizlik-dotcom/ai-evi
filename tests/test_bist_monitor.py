import pathlib
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "bridge"))
import bist_monitor as monitor

class Monitoring(unittest.TestCase):
    def test_trt_session_boundaries(self):
        from datetime import datetime
        stamp=lambda s:datetime.fromisoformat(s.replace("Z","+00:00")).timestamp()
        self.assertTrue(monitor.session_open(stamp("2026-10-09T07:00:00Z")))
        self.assertFalse(monitor.session_open(stamp("2026-10-09T06:59:00Z")))
        self.assertFalse(monitor.session_open(stamp("2026-10-10T09:00:00Z")))

    def test_polls_only_monitors_without_candidate_or_ai_calls(self):
        calls=[]
        def worker(path, body=None):
            calls.append((path, body))
            return {"symbols":["RTALB","RTALB"]} if body is None else {"bar_time":"2026-10-09T12:15:00Z","engine":{"opened":1}}
        with patch.object(monitor,"session_open",return_value=True), patch.object(monitor.feed,"worker_config"), patch.object(monitor.feed,"worker_call",side_effect=worker), patch.object(monitor.feed,"yahoo",return_value=[{"symbol":"RTALB"}]) as yahoo, patch.object(monitor.time,"sleep"):
            self.assertEqual(monitor.poll_once(),0)
        self.assertEqual(yahoo.call_count,1)
        self.assertEqual(len(calls),2)
        self.assertEqual(calls[1][1]["purpose"],"MONITOR")
        self.assertNotIn("run_id",calls[1][1])
        self.assertEqual(calls[1][1]["source"],"YAHOO_INDICATIVE")

    def test_provider_error_never_ingests_or_fabricates_price(self):
        with patch.object(monitor,"session_open",return_value=True), patch.object(monitor.feed,"worker_config"), patch.object(monitor.feed,"worker_call",return_value={"symbols":["RTALB"]}) as call, patch.object(monitor.feed,"yahoo",side_effect=monitor.feed.FeedError("YAHOO_NO_CLOSED_BARS")), patch.object(monitor.time,"sleep"):
            self.assertEqual(monitor.poll_once(),1)
            self.assertEqual(call.call_count,1)
