import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validate, fresh, entryPlan, exitPlan, technicalSignal, ingest, eligibleEntryBar, stageOneMetrics} from '../worker/cloud_bridge.mjs';
const now=Date.parse('2026-10-09T07:31:00Z');
const bar={symbol:'TUPRS',interval:'15m',time:'2026-10-09T07:00:00Z',open:100,high:101,low:99,close:100.5,volume:1000000};
const payload={source:'YAHOO_INDICATIVE',feed_type:'INDICATIVE_INTRADAY',bars:[bar]};
test('valid UTC closed bar; rejects open/NaN/invalid OHLC, multiple symbols',()=>{
 assert.equal(validate(payload,now).bars.length,1);
 for(const change of [{time:'2026-10-09T07:30:00Z'},{low:102},{open:0},{volume:NaN},{time:'bad'}])
  assert.throws(()=>validate({...payload,bars:[{...bar,...change}]},now));
 assert.throws(()=>validate({...payload,bars:[bar,{...bar,symbol:'THYAO'}]},now));
});
test('EOD/stale/weekend never ACTIVE',()=>{
 assert.equal(fresh({...bar,feed_type:'INDICATIVE_INTRADAY'},now),true);
 assert.equal(fresh({...bar,feed_type:'EOD'},now),false);
 assert.equal(fresh({...bar,feed_type:'INDICATIVE_INTRADAY'},now+3600000),false);
 assert.equal(fresh({...bar,time:'2026-10-10T07:00:00Z',feed_type:'INDICATIVE_INTRADAY'},Date.parse('2026-10-10T07:16:00Z')),false);
});
test('1250 slot integer lots include fees and slippage',()=>{
 const p=entryPlan(2500,100);assert.equal(p.qty,12);
 assert.ok(p.qty*p.executed+p.commission<=1250);
 assert.equal(entryPlan(100,200).qty,0);
});
test('net TP/SL and conservative ambiguous candle',()=>{
 const p=entryPlan(2500,100),t={executed_price:p.executed,lot_count:p.qty,commission:p.commission,entry_time:bar.time};
 const cost=t.executed_price*t.lot_count+t.commission;
 const tp=exitPlan(t,[{bar_time:bar.time,open:102,high:110,low:102}]);
 assert.ok(Math.abs(tp.pnl/cost-.03)<1e-12);
 const sl=exitPlan(t,[{bar_time:bar.time,open:100,high:110,low:95}]);
 assert.equal(sl.reason,'STOP_NET_1_5_PCT');assert.ok(Math.abs(sl.pnl/cost+.015)<1e-12);
 const gap=exitPlan(t,[{bar_time:bar.time,open:90,high:110,low:89}]);assert.ok(gap.pnl/cost<-.015);
});
test('signal requires actual breakout/volume and never claims risk verified',()=>{
 const rows=Array.from({length:20},()=>({time:bar.time,open:99,high:100,low:98,close:99,volume:1000000}));
 assert.equal(technicalSignal(rows),null);
 assert.equal(technicalSignal([...rows,{time:bar.time,open:100,high:104,low:100,close:103.5,volume:3000000}]).risk_verified,false);
});
test('stream body limit prevents DB write',async()=>{
 const response=await ingest(new Request('https://example.test/bist/feed/ingest',{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(100001)}),{DB:{}},now);
 assert.equal(response.status,413);
});
test('server has only the OpenAI referee egress and compiled module matches tested source',()=>{
 const worker=readFileSync(new URL('../worker/index.js',import.meta.url),'utf8');
 const module=readFileSync(new URL('../worker/cloud_bridge.mjs',import.meta.url),'utf8').replace(/^export /gm,'');
 assert.ok(worker.startsWith(module));
 const server=worker.replace(/ const dashboard=String.raw`[\s\S]*?`;/,'');
 assert.doesNotMatch(server.replace('async fetch(request,env)', 'async handler(request,env)').replace(/globalThis\.fetch\(\.\.\.args\)/g,'boundGlobalNetwork'),/\bfetch\s*\(/g); // method declaration below is exempted separately
});
test('actual Worker rejects missing/wrong token; ingress cannot use cookie auth',async()=>{
 const code=readFileSync(new URL('../worker/index.js',import.meta.url),'utf8');
 const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const env={ACCESS_TOKEN:'unit-test-only',DB:{}};
 for(const headers of [{},{Authorization:'Bearer wrong'},{Cookie:'bist_session=fake'}]){
  const r=await worker.fetch(new Request('https://example.test/bist/feed/ingest',{method:'POST',headers}),env);
  assert.equal(r.status,401);
 }
 const status=await worker.fetch(new Request('https://example.test/bist/provider/probe',{method:'POST',headers:{Authorization:'Bearer unit-test-only'}}),env);
 assert.equal(status.status,410);
});

test('snapshot rejected in Worker too; all valid BIST symbols admitted',()=>{
 assert.throws(()=>validate({...payload,bars:[{...bar,time:'2026-10-09T07:03:55Z'}]},now));
 assert.equal(validate({...payload,bars:[{...bar,symbol:'ACSEL'}]},now).bars[0].symbol,'ACSEL');
 assert.throws(()=>validate({...payload,bars:[{...bar,symbol:'../../evil'}]},now));
});
test('35 minute freshness boundary and legacy snapshot filtering',()=>{
 const row={...bar,feed_type:'INDICATIVE_INTRADAY'};
 const end=Date.parse(bar.time)+900000;
 assert.equal(fresh(row,end+35*60000),true);
 assert.equal(fresh(row,end+35*60000+1),false);
 assert.equal(fresh({...row,time:'2026-10-09T07:23:55Z'},Date.parse('2026-10-09T07:45:00Z')),false);
});
test('N+1 entry only if known by its open; delayed Yahoo cannot backdate a fill',()=>{
 const candles=['07:00','07:15','07:30','07:45'].map(t=>({bar_time:'2026-10-09T'+t+':00.000Z',open:100}));
 const signal={bar_time:candles[0].bar_time,observed_at:candles[1].bar_time,expires_at:candles[3].bar_time};
 assert.equal(eligibleEntryBar(signal,candles).bar_time,candles[1].bar_time);
 assert.equal(eligibleEntryBar({...signal,observed_at:'2026-10-09T07:31:00.000Z'},candles).bar_time,candles[3].bar_time);
 assert.equal(eligibleEntryBar({...signal,observed_at:'2026-10-09T07:46:00.000Z'},candles),null);
 const chosen=eligibleEntryBar(signal,candles);
 assert.equal(entryPlan(2500,chosen.open).executed,100.2);
});

test('Worker independently enforces RVOL2 green/body/wick before breakout/VWAP',()=>{
 const previous=Array.from({length:20},()=>({time:bar.time,open:99,high:100,low:98,close:99,volume:1000000}));
 const last={time:bar.time,open:100,high:104,low:100,close:103.5,volume:2000000};
 assert.equal(stageOneMetrics([...previous,last]).rvol,2);
 assert.ok(technicalSignal([...previous,last]));
 assert.equal(technicalSignal([...previous,{...last,high:110}]),null);
 assert.equal(technicalSignal([...previous,{...last,close:100.1}]),null);
 assert.equal(technicalSignal([...previous,{...last,volume:1990000}]),null);
});
test('full funnel: hot ingest → global selection → future eligible entry → stop → retry preserves cash',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {execFileSync}=await import('node:child_process');
 const {riskIngest,finalize,monitorSymbols,feedStatus,reportIngest,geminiDecision}=await import('../worker/cloud_bridge.mjs');
 const dir=mkdtempSync(join(tmpdir(),'bist-test-')),path=join(dir,'db.sqlite');
 const adapter=new URL('./funnel_sqlite.py',import.meta.url).pathname;
 const call=data=>JSON.parse(execFileSync('python3',[adapter,path],{input:JSON.stringify(data),encoding:'utf8'}));
 call({init:true});
 const db={prepare(sql){return {sql,params:[],bind(...p){this.params=p;return this;},async all(){return call({statements:[this]})[0];},async first(){return (await this.all()).results[0]||null;},async run(){return await this.all();}};},async batch(statements){return call({statements});}};
 const env={DB:db,OPENAI_API_KEY:'unit-test-only'};const mockAI=async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({onay:true,neden:'Teknik koşullar ve resmi tedbir durumu uygun.',guven:85})}}],usage:{prompt_tokens:100,completion_tokens:20}}));const req=body=>new Request('https://example.test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{
  const risk={source:'https://www.borsaistanbul.com/erd/menkul_tedbir_listesi.csv',as_of:'2026-10-09T07:00:00Z',valid_until:'2026-10-09T21:00:00Z'};
  assert.equal((await riskIngest(req({symbols:['TUPRS'],eligible_symbols:['TUPRS'],risk,risk_status:'VERIFIED_OFFICIAL_RESTRICTIONS'}),env,now)).status,200);
  const previous=Array.from({length:20},(_,i)=>({...bar,time:new Date(Date.parse('2026-10-08T07:00:00Z')+i*900000).toISOString(),open:99,high:100,low:98,close:99,volume:1000000}));
  const signalBar={...bar,open:100,high:104,low:100,close:103.5,volume:2000000};
  const batch={...payload,bars:[...previous,signalBar],purpose:'HOT_CANDIDATE',run_id:'test-1'};
  const first=await (await ingest(req(batch),env,now)).json();assert.equal(first.stage2,'MOMENTUM_PASSED');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM virtual_trades').first()).n,0);
  const beforeGemini=await (await finalize(req({run_id:'test-1'}),env,now+60000,mockAI)).json();assert.equal(beforeGemini.signals_created,0);
  assert.equal((await geminiDecision(req({run_id:'test-1',symbol:'TUPRS',bar_time:first.bar_time,model:'gemini-3.1-flash-lite',status:'APPROVED',verdict:{approved:true,confidence:85,reason:'Teknik uygun'}}),env,now)).status,200);
  const selected=await (await finalize(req({run_id:'test-1'}),env,now+60000,mockAI)).json();assert.deepEqual(selected.selected,['TUPRS']);assert.equal(selected.signals_created,1);
  assert.equal((await (await finalize(req({run_id:'test-1'}),env,now+60000,mockAI)).json()).signals_created,0);
  assert.deepEqual((await (await monitorSymbols(env,now+60000)).json()).symbols,['TUPRS']);
  await db.prepare("UPDATE bist_sniper_queue SET status='EXPIRED'").run();
  const entryBar={...bar,time:'2026-10-09T07:45:00Z',open:103.4,high:104,low:103,close:103.6,volume:1000000};
  await ingest(req({...batch,purpose:'MONITOR',bars:[...previous,signalBar,entryBar]}),env,Date.parse('2026-10-09T08:16:00Z'));
  const trade=await db.prepare('SELECT * FROM virtual_trades').first();assert.equal(trade.entry_time,'2026-10-09T07:45:00.000Z');assert.ok(Math.abs(trade.executed_price-103.4*1.002)<1e-10);
  const stopBar={...bar,time:'2026-10-09T08:00:00Z',open:104,high:115,low:90,close:104,volume:1000000};
  const closeBatch={...batch,purpose:'MONITOR',bars:[...previous,signalBar,entryBar,stopBar]};
  const backfill=await (await ingest(req(closeBatch),env,Date.parse('2026-10-09T09:31:00Z'))).json();assert.equal(backfill.status,'BLOCKED_MARKET_DATA_UNAVAILABLE');assert.equal(backfill.engine.closed,1);
  const closed=await db.prepare('SELECT * FROM virtual_trades').first();assert.equal(closed.exit_reason,'STOP_NET_1_5_PCT');assert.equal(closed.status,'CLOSED');assert.equal(closed.exit_time,'2026-10-09T08:15:00.000Z');const audit=await db.prepare('SELECT * FROM bist_exit_audit').first();assert.equal(audit.exit_bar_time,'2026-10-09T08:00:00.000Z');assert.equal(audit.exit_observed_at,'2026-10-09T09:31:00.000Z');
  const cash=await db.prepare("SELECT available_cash cash FROM paper_cash_accounts WHERE strategy='SCALP'").first();
  await ingest(req(closeBatch),env,Date.parse('2026-10-09T08:31:00Z'));
  assert.deepEqual(await db.prepare("SELECT available_cash cash FROM paper_cash_accounts WHERE strategy='SCALP'").first(),cash);
  assert.ok((await feedStatus(db,Date.parse('2026-10-09T08:31:00Z'))).scanner_live);
  assert.equal((await reportIngest(req({run_id:'test-1',shard:0,universe_total:631,eligible_total:530,assigned:67,fetched:60,hot:1,posted:1,errors:7,last_bar_time:stopBar.time}),env,Date.parse('2026-10-09T08:31:00Z'))).status,200);
  const coverage=await feedStatus(db,Date.parse('2026-10-09T08:31:00Z'));assert.equal(coverage.scanned_symbols,60);assert.equal(coverage.eligible_total,530);assert.equal(coverage.shards_completed,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('AI uses strict schema, fixed endpoint, no redirects and fails closed on malformed output',async()=>{
 const {aiVerdict}=await import('../worker/cloud_bridge.mjs');
 const rows=Array.from({length:20},()=>({...bar,open:99,high:100,low:98,close:99,volume:1000000}));
 const c={symbol:'TUPRS',bar_time:bar.time,metrics_json:JSON.stringify(technicalSignal([...rows,{...bar,open:100,high:104,low:100,close:103.5,volume:2000000}]))};
 const risk={eligible:1,source:'official',as_of:bar.time,valid_until:'2026-10-09T21:00:00Z'};
 const mock=async(url,opts)=>{assert.equal(url,'https://api.openai.com/v1/chat/completions');assert.equal(opts.redirect,'manual');const b=JSON.parse(opts.body);assert.equal(b.model,'gpt-4o-mini');assert.equal(b.response_format.json_schema.strict,true);assert.equal(b.max_completion_tokens,200);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"onay":false,"neden":"Kırılım zayıf.","guven":20}'}}]}));};
 assert.equal((await aiVerdict({OPENAI_API_KEY:'unit-test-only'},c,risk,mock)).onay,false);
 await assert.rejects(aiVerdict({},c,risk,mock),/OPENAI_KEY_MISSING/);
 await assert.rejects(aiVerdict({OPENAI_API_KEY:'unit-test-only'},c,risk,async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"onay":"true","neden":"bad"}'}}]}))),/OPENAI_BAD_VERDICT/);
 await assert.rejects(aiVerdict({OPENAI_API_KEY:'unit-test-only'},c,risk,async()=>new Response('error',{status:429})),/OPENAI_HTTP_429/);
 await assert.rejects(aiVerdict({OPENAI_API_KEY:'unit-test-only'},c,risk,async()=>new Response('',{status:302,headers:{Location:'https://example.test'}})),/OPENAI_HTTP_302/);
});
test('entire six-candidate pool reviewed; rejections excluded and retries never call AI again',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const {finalize}=await import('../worker/cloud_bridge.mjs');const dir=mkdtempSync(join(tmpdir(),'bist-ai-')),path=join(dir,'db.sqlite');
 const adapter=new URL('./funnel_sqlite.py',import.meta.url).pathname;const call=data=>JSON.parse(execFileSync('python3',[adapter,path],{input:JSON.stringify(data),encoding:'utf8'}));call({init:true});
 const db={prepare(sql){return {sql,params:[],bind(...p){this.params=p;return this;},async all(){return call({statements:[this]})[0];},async first(){return (await this.all()).results[0]||null;},async run(){return await this.all();}};},async batch(statements){return call({statements});}};
 try{
  const previous=Array.from({length:20},()=>({...bar,open:99,high:100,low:98,close:99,volume:1000000}));const metrics=JSON.stringify(technicalSignal([...previous,{...bar,open:100,high:104,low:100,close:103.5,volume:2000000}]));
  for(let i=0;i<6;i++){const symbol='TEST'+i;await db.prepare('INSERT INTO bist_funnel_risk VALUES(?,1,?,?,?)').bind(symbol,bar.time,'2026-10-09T21:00:00Z','https://www.borsaistanbul.com/erd/menkul_tedbir_listesi.csv').run();await db.prepare('INSERT INTO bist_funnel_candidates VALUES(?,?,?,?,?,?)').bind('six',symbol,bar.time,new Date(now).toISOString(),10-i,metrics).run();await db.prepare("INSERT INTO bist_gemini_decisions VALUES(?,?,?,?,?,'APPROVED',85,'OK',?)").bind(symbol+':'+bar.time,'six',symbol,bar.time,'gemini-3.1-flash-lite',new Date(now).toISOString()).run();}
  let calls=0;const mock=async()=>{const approved=++calls!==6;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({onay:approved,neden:approved?'Teknik uygun.':'Kırılım zayıf.',guven:approved?85:20})}}]}));};
  const req=()=>new Request('https://example.test',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"run_id":"six"}'});const env={DB:db,OPENAI_API_KEY:'unit-test-only'};
  const result=await (await finalize(req(),env,now,mock)).json();assert.equal(calls,6);assert.equal(result.candidates_reviewed,6);assert.equal(result.selected.length,5);assert.equal(result.rejected,1);
  const retry=await (await finalize(req(),env,now,mock)).json();assert.equal(calls,6);assert.equal(retry.signals_created,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('TRT session and turnover use Istanbul date without shifting UTC epochs',async()=>{
 const {sessionOpen,dailyTurnover}=await import('../worker/cloud_bridge.mjs');
 assert.equal(sessionOpen(Date.parse('2026-10-09T06:59:00Z')),false);
 assert.equal(sessionOpen(Date.parse('2026-10-09T07:00:00Z')),true);
 assert.equal(sessionOpen(Date.parse('2026-10-09T15:05:00Z')),true);
 assert.equal(sessionOpen(Date.parse('2026-10-09T15:06:00Z')),false);
 const current={...bar,volume:400000,close:100};
 assert.equal(dailyTurnover([{...current,time:'2026-10-08T07:00:00Z',volume:1e9},current]),40000000);
 assert.equal(dailyTurnover([{...current,time:'2026-10-09T06:45:00Z',volume:1e9},current]),40000000);
 const history=Array.from({length:20},()=>({...bar,time:'2026-10-08T07:00:00Z',volume:100000}));
 assert.ok(stageOneMetrics([...history,{...current,open:98,high:100,low:98}]));
 assert.equal(stageOneMetrics([...history,{...current,open:98,high:100,low:98,volume:399999}]),null);
});
test('backfill is chronological, excludes pre-entry bars, and stops on first touched candle',()=>{
 const p=entryPlan(2500,100),trade={executed_price:p.executed,lot_count:p.qty,commission:p.commission,entry_time:'2026-10-09T08:00:00Z'};
 const later={bar_time:'2026-10-09T08:30:00Z',open:100,high:120,low:90};
 const early={bar_time:'2026-10-09T08:15:00Z',open:102,high:110,low:102};
 const before={...later,bar_time:'2026-10-09T07:45:00Z'};
 const exit=exitPlan(trade,[later,before,early]);
 assert.equal(exit.reason,'TP_NET_3_PCT');assert.equal(exit.quote_time,early.bar_time);
 assert.equal(exit.time,'2026-10-09T08:30:00.000Z');
});

test('backfill loads entry history beyond 100 bars and excludes future/unclosed bars',async()=>{
 const {symbolBars}=await import('../worker/cloud_bridge.mjs');
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'bist-history-')),path=join(dir,'db.sqlite'),adapter=new URL('./funnel_sqlite.py',import.meta.url).pathname;
 const call=data=>JSON.parse(execFileSync('python3',[adapter,path],{input:JSON.stringify(data),encoding:'utf8'}));call({init:true});
 const db={prepare(sql){return {sql,params:[],bind(...p){this.params=p;return this;},async all(){return call({statements:[this]})[0];},async first(){return (await this.all()).results[0]||null;},async run(){return this.all();}};}};
 try{
  const start=Date.parse('2026-10-05T07:00:00Z'),check=start+122*900000;
  await db.prepare("INSERT INTO virtual_trades(strategy,symbol,status,entry_time) VALUES('SCALP','TUPRS','OPEN',?)").bind(new Date(start).toISOString()).run();
  const data=Array.from({length:123},(_,i)=>({time:new Date(start+i*900000).toISOString(),high:i===1?110:101,low:100}));
  await db.prepare("INSERT INTO bist_bridge_bars SELECT 'TUPRS','15m',json_extract(value,'$.time'),100,json_extract(value,'$.high'),100,100,1,'YAHOO_INDICATIVE',json_extract(value,'$.time') FROM json_each(?)").bind(JSON.stringify(data)).run();
  const bars=await symbolBars(db,'TUPRS',check);assert.equal(bars.length,122);
  const p=entryPlan(2500,100),exit=exitPlan({executed_price:p.executed,lot_count:p.qty,commission:p.commission,entry_time:data[0].time},bars);
  assert.equal(exit.quote_time,data[1].time);assert.equal(exit.reason,'TP_NET_3_PCT');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Scalp timeout uses latest closed candle at 60m; TP/SL history takes priority',()=>{
 const t={executed_price:100,lot_count:10,commission:2,entry_time:'2026-10-09T10:00:00Z'};
 const b=(minute,changes={})=>({bar_time:new Date(Date.parse(t.entry_time)+minute*60000).toISOString(),open:100,high:100.5,low:100,close:100.2,...changes});
 assert.equal(exitPlan(t,[b(0),b(15),b(30)]),null);
 assert.equal(exitPlan(t,[]),null);
 assert.equal(exitPlan(t,[b(-15)]),null);
 const at60=exitPlan(t,[b(0),b(15),b(30),b(45)]);
 assert.equal(at60.reason,'TIME_EXIT');assert.equal(at60.time,'2026-10-09T11:00:00.000Z');
 const latest=exitPlan(t,[b(75,{close:100.3}),b(0),b(45)]);
 assert.equal(latest.reason,'TIME_EXIT');assert.equal(latest.time,'2026-10-09T11:30:00.000Z');assert.equal(latest.executed,100.3*.998);
 assert.ok(Math.abs(latest.pnl-(100.3*.998*10*.998-1002))<1e-9);
 assert.equal(exitPlan(t,[b(0),b(15,{high:110}),b(75)]).reason,'TP_NET_3_PCT');
 assert.equal(exitPlan(t,[b(0),b(15,{low:90,high:110}),b(75)]).reason,'STOP_NET_1_5_PCT');
});
