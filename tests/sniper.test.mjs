import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {sniperAdvance,initialSniperState,sniperEntryPlan,entryWindow,ingest,riskIngest,finalize,enforceSessionClose,monitorSymbols,refreshStandby} from '../worker/cloud_bridge.mjs';
const trade={executed_price:100.2,lot_count:24,commission:4.8096,entry_time:'2026-10-09T07:45:00.000Z'};
const candle=(time,o,h,l,c,v=300)=>({symbol:'TUPRS',interval:'15m',time,bar_time:time,open:o,high:h,low:l,close:c,volume:v});
test('Sniper uses whole own cash, net2% base stop and adverse gap',()=>{
 const p=sniperEntryPlan(2500,100);assert.equal(p.qty,24);assert.ok(p.executed*p.qty+p.commission<=2500);
 const s=initialSniperState(trade),stop=sniperAdvance(trade,s,[candle(trade.entry_time,100,110,90,101)]).exit;
 const cost=trade.executed_price*trade.lot_count+trade.commission;assert.ok(Math.abs(stop.pnl/cost+.02)<1e-10);
 assert.ok(sniperAdvance(trade,s,[candle(trade.entry_time,90,110,89,101)]).exit.pnl/cost<-.02);
});
test('current candle high only raises next candle stop; +2.5% arms net breakeven',()=>{
 const s=initialSniperState(trade),first=sniperAdvance(trade,s,[candle(trade.entry_time,100.2,104,99,103)]);
 assert.equal(first.exit,null);assert.equal(first.state.breakeven,1);assert.ok(first.state.stop_price>=initialSniperState(trade).stop_price);
 const second=sniperAdvance(trade,first.state,[candle('2026-10-09T08:00:00.000Z',103,110,98,105)]);assert.ok(second.exit);assert.equal(second.exit.reason,'SNIPER_TRAILING_STOP_2_PCT');
});
test('momentum expires after 60 minutes without a new high; entry locks at17:55TRT',()=>{
 const state={...initialSniperState(trade),peak_price:102,stop_price:98,last_peak_at:trade.entry_time};
 const bars=Array.from({length:4},(_,i)=>candle(new Date(Date.parse(trade.entry_time)+i*900000).toISOString(),101,101.5,100,101));
 assert.equal(sniperAdvance(trade,state,bars).exit.reason,'SNIPER_NO_NEW_HIGH_60_MIN');
 assert.equal(entryWindow(Date.parse('2026-10-09T14:54:00Z')),true);assert.equal(entryWindow(Date.parse('2026-10-09T14:55:00Z')),false);
});
function database(){const dir=mkdtempSync(join(tmpdir(),'sniper-')),path=join(dir,'db.sqlite'),adapter=new URL('./funnel_sqlite.py',import.meta.url).pathname;
 const call=data=>JSON.parse(execFileSync('python3',[adapter,path],{input:JSON.stringify(data),encoding:'utf8'}));call({init:true});
 const db={prepare(sql){return {sql,params:[],bind(...p){this.params=p;return this;},async all(){return call({statements:[this]})[0];},async first(){return (await this.all()).results[0]||null;},async run(){return this.all();}};},async batch(statements){return call({statements});}};return {db,clean:()=>rmSync(dir,{recursive:true,force:true})};}
const req=body=>new Request('https://example.test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const ai=async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"onay":true,"neden":"Teknik uygun.","guven":85}'}}]}));
test('two engines: best standby takes one Sniper slot; replacement waits until exit observed;17:55 closes once',async()=>{
 const {db,clean}=database(),env={DB:db,OPENAI_API_KEY:'unit-test-only'},now=Date.parse('2026-10-09T07:31:00Z');
 const histories={};const envelope=(symbol,bars,purpose='MONITOR')=>({source:'YAHOO_INDICATIVE',feed_type:'INDICATIVE_INTRADAY',run_id:'sniper',purpose,bars:bars.map(b=>({...b,symbol}))});
 try{
  await riskIngest(req({symbols:['TUPRS','ASELS'],eligible_symbols:['TUPRS','ASELS'],risk_status:'VERIFIED_OFFICIAL_RESTRICTIONS',risk:{source:'https://www.borsaistanbul.com/erd/menkul_tedbir_listesi.csv',as_of:'2026-10-09T07:00:00Z',valid_until:'2026-10-09T21:00:00Z'}}),env,now);
  for(const [symbol,close] of [['TUPRS',103.5],['ASELS',103.2]]){
   const old=Array.from({length:20},(_,i)=>candle(new Date(Date.parse('2026-10-08T07:00:00Z')+i*900000).toISOString(),99,100,98,99,100));
   histories[symbol]=[...old,candle('2026-10-09T07:00:00Z',100,104,100,close,200)];await ingest(req(envelope(symbol,histories[symbol],'HOT_CANDIDATE')),env,now);
  }
  const selection=await (await finalize(req({run_id:'sniper'}),env,now+60000,ai)).json();assert.equal(selection.selected.length,2);
  histories.TUPRS.push(candle('2026-10-09T07:45:00Z',103.4,106.5,103,106));
  await ingest(req(envelope('TUPRS',histories.TUPRS)),env,Date.parse('2026-10-09T08:16:00Z'));
  let active=await db.prepare("SELECT * FROM virtual_trades WHERE status='OPEN'").all();assert.equal(active.results.length,1);assert.equal(active.results[0].strategy,'SWING');assert.equal(active.results[0].symbol,'TUPRS');assert.ok(active.results[0].lot_count>12);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM bist_sniper_queue WHERE status='READY'").first()).n,1);
  assert.ok((await (await monitorSymbols(env,Date.parse('2026-10-09T08:16:00Z'))).json()).symbols.includes('ASELS'));
  histories.TUPRS.push(candle('2026-10-09T08:00:00Z',107,115,90,106));await ingest(req(envelope('TUPRS',histories.TUPRS)),env,Date.parse('2026-10-09T08:31:00Z'));
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM virtual_trades WHERE strategy='SWING' AND status='OPEN'").first()).n,0);
  // An already stored old open must never become the replacement's entry.
  histories.ASELS.push(candle('2026-10-09T07:45:00Z',103,106.5,103,106),candle('2026-10-09T08:00:00Z',106,108.5,106,108,400));await ingest(req(envelope('ASELS',histories.ASELS)),env,Date.parse('2026-10-09T08:31:00Z'));
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM virtual_trades WHERE strategy='SWING' AND status='OPEN'").first()).n,0);
  histories.ASELS.push(candle('2026-10-09T08:45:00Z',106,107,105.8,106.8));await ingest(req(envelope('ASELS',histories.ASELS)),env,Date.parse('2026-10-09T09:16:00Z'));
  active=await db.prepare("SELECT * FROM virtual_trades WHERE strategy='SWING' AND status='OPEN'").first();assert.ok(active);assert.equal(active.symbol,'ASELS');assert.equal(active.entry_time,'2026-10-09T08:45:00.000Z');
  const eod=Date.parse('2026-10-09T14:55:00Z');assert.equal((await enforceSessionClose(db,eod)).closed,1);
  const cash=await db.prepare('SELECT * FROM paper_cash_accounts').all();assert.equal((await enforceSessionClose(db,eod+60000)).closed,0);assert.deepEqual((await db.prepare('SELECT * FROM paper_cash_accounts').all()).results,cash.results);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM virtual_trades WHERE status='OPEN'").first()).n,0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM bist_daily_reports').first()).n,1);
 }finally{clean();}
});
test('bad standby candle is invalidated and panel includes ranked standby and copyable report',async()=>{
 const {db,clean}=database();try{
  await db.prepare("INSERT INTO bist_sniper_queue VALUES('k','TUPRS','2026-10-09T07:00:00Z','2026-10-09T07:31:00Z','2026-10-09T09:00:00Z','2026-10-09T07:00:00Z','2026-10-09T07:31:00Z',10,80,'READY','OK','{}')").run();
  const bars=Array.from({length:21},(_,i)=>candle(new Date(Date.parse('2026-10-09T07:00:00Z')+i*900000).toISOString(),100,110,90,99,100));
  await refreshStandby(db,'TUPRS',bars,Date.parse('2026-10-09T12:16:00Z'));assert.equal((await db.prepare('SELECT status FROM bist_sniper_queue').first()).status,'INVALID');
  const code=readFileSync(new URL('../worker/index.js',import.meta.url),'utf8');assert.match(code,/sniperStandby/);assert.match(code,/copyReport/);assert.match(code,/enforceSessionClose\(env.DB,controller.scheduledTime/);
 }finally{clean();}
});
