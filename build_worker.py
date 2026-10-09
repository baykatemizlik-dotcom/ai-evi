"""Deterministically bundle the tested engine modules and PWA. No external files."""
from pathlib import Path
import re
root=Path(__file__).resolve().parent
parts=[]
for name in ['cloud_bridge.mjs','strategy_engines.mjs']:
 text=(root/'worker'/name).read_text()
 text=re.sub(r'^import .*?;\n','',text,flags=re.M)
 parts.append(re.sub(r'^export ','',text,flags=re.M))
shell=(root/'worker/app_shell.mjs').read_text().replace('@@DASHBOARD@@',(root/'worker/dashboard.html').read_text())
(root/'worker/index.js').write_text('\n'.join(parts)+'\n'+shell)
