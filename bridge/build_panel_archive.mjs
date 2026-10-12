// Build private presentation snapshots from an already downloaded SQL backup.
// Read-only SQLite adapter: no production D1 calls and no original data changes.
import {execFileSync} from 'node:child_process';import {readFileSync,writeFileSync} from 'node:fs';
import {isolatedOverview} from '../worker/strategy_engines.mjs';
import {opportunitiesOverview,reconstructOpportunity} from '../worker/opportunities.mjs';
import {feedStatus,geminiStatus,aiStatus,trtDate} from '../worker/cloud_bridge.mjs';
import {trialOverview} from '../worker/trial_engines.mjs';
const [database,reconstructionPath,out]=process.argv.slice(2);if(!out)throw Error('usage: node build_panel_archive.mjs readonly.sqlite reconstruction.json output.json');
const adapter=`import sqlite3,json,sys\ndb=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);db.row_factory=sqlite3.Row\nx=json.load(sys.stdin);rows=db.execute(x['sql'],x.get('params',[])).fetchall();print(json.dumps({'results':[dict(r) for r in rows]}))`;
const db={prepare(sql){return {bind(...params){this.params=params;return this;},async all(){return JSON.parse(execFileSync('python3',['-c',adapter,database],{input:JSON.stringify({sql,params:this.params||[]}),encoding:'utf8',maxBuffer:10_000_000}));},async first(){return (await this.all()).results[0]||null;}};}};
const now=Date.now(),captured_at=new Date(now).toISOString(),date=trtDate(now),reconstruction=JSON.parse(readFileSync(reconstructionPath,'utf8'));
const env={DB:db,OPENAI_API_KEY:'configured-placeholder-for-status-only'};
const data={overview:{...await isolatedOverview(db,now),gemini:await geminiStatus(env)},status:await feedStatus(db,now),connections:{mode:'CLOUD_BRIDGE_AI_REFEREE',gemini:await geminiStatus(env),openai:await aiStatus(env)},trials:await trialOverview(db),['opportunities:'+date]:await opportunitiesOverview(db,date,now,reconstruction)};
writeFileSync(out,JSON.stringify(Object.fromEntries(Object.entries(data).map(([k,v])=>['snapshot:'+k,{captured_at,archive_origin:'FULL_D1_BACKUP',data:v}]))));
const events=await db.prepare('SELECT * FROM opportunity_events WHERE captured_at>=? AND captured_at<?').bind(new Date(date+'T00:00:00+03:00').toISOString(),new Date(Date.parse(date+'T00:00:00+03:00')+86400000).toISOString()).all();
const budgets=Object.fromEntries((await db.prepare('SELECT strategy,initial_cash FROM paper_cash_accounts').all()).results.map(r=>[r.strategy,r.initial_cash/2]));
writeFileSync(out+'.reconstructed.json',JSON.stringify({trt_date:date,retrieved_at:reconstruction.retrieved_at,entries:reconstruction.entries,scenarios:Object.fromEntries(events.results.map(e=>[e.event_key,reconstructOpportunity(e,reconstruction,now,budgets[e.strategy])]))}));
console.log(JSON.stringify({captured_at,opportunities:data['opportunities:'+date].opportunities.length,reconstructed_stages:data['opportunities:'+date].opportunities.flatMap(x=>x.stages).filter(x=>x.scenario.retrospective).length}));
