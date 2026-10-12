"""Refresh the dashboard in the canonical deployed Worker.

The Worker includes edge bridge and sector code absent from older standalone
modules. Preserve that code while updating only the panel literal.
"""
from pathlib import Path
import json

root = Path(__file__).resolve().parent
worker = root / 'worker/index.js'
source = worker.read_text()
marker = 'const dashboard=String.raw`'
start = source.index(marker) + len(marker)
end = source.index('`;\n', start)
report = json.loads((root / 'data/replay_2026-10-12.json').read_text())
dashboard = (root / 'worker/dashboard.html').read_text().replace(
    '@@REPLAY_REPORT@@',
    json.dumps(report, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/'),
)
if '`' in dashboard or '${' in dashboard.replace('${JSON.stringify(BIST_SECTORS)}', ''):
    raise ValueError('Unsafe dashboard template literal')
worker.write_text(source[:start] + dashboard + source[end:])
