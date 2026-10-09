"""Temporary SQLite adapter for Node integration tests; no production/network use."""
import json,sqlite3,sys,pathlib
path=sys.argv[1];data=json.load(sys.stdin);db=sqlite3.connect(path)
if data.get('init'):
 db.executescript('''CREATE TABLE virtual_trades(id INTEGER PRIMARY KEY AUTOINCREMENT,strategy TEXT NOT NULL,symbol TEXT NOT NULL,signal_price REAL,executed_price REAL,lot_count INTEGER,commission REAL,entry_time TEXT,exit_time TEXT,exit_price REAL,pnl_net REAL,exit_reason TEXT,status TEXT,slot_id INTEGER);
 CREATE TABLE bist_universe(symbol TEXT PRIMARY KEY,active INT);
 CREATE TABLE paper_cash_accounts(strategy TEXT PRIMARY KEY,initial_cash REAL,available_cash REAL,updated_at TEXT);
 CREATE TABLE bist_bridge_bars(symbol TEXT,interval TEXT,bar_time TEXT,open REAL,high REAL,low REAL,close REAL,volume REAL,source TEXT,received_at TEXT,PRIMARY KEY(symbol,interval,bar_time));''')
 root=pathlib.Path(__file__).resolve().parents[1]
 for file in ['0010_cloud_bridge.sql','0011_dynamic_funnel.sql','0012_ai_referee.sql','0013_sniper.sql','0014_external_audit.sql','0015_gemini_and_exit_audit.sql','0016_web_push.sql','0017_strategy_isolation.sql']:
  if file=='0017_strategy_isolation.sql' and data.get('pre_isolation'):continue
  db.executescript((root/'migrations'/file).read_text())
 db.execute("INSERT OR IGNORE INTO paper_cash_accounts VALUES('SWING',2500,2500,'2026-10-09T00:00:00Z')");db.commit();print('{}');sys.exit()
db.row_factory=sqlite3.Row
results=[]
try:
 for item in data['statements']:
  cursor=db.execute(item['sql'],item.get('params',[]));rows=[dict(x) for x in cursor.fetchall()]
  changes=db.execute('SELECT changes()').fetchone()[0]
  results.append({'results':rows,'meta':{'changes':changes}})
 db.commit();print(json.dumps(results))
except Exception:
 db.rollback();raise
