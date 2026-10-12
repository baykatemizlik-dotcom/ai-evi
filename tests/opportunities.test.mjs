import test from 'node:test';import assert from 'node:assert/strict';
import {morningPremium,simulateOpportunity} from '../worker/opportunities.mjs';
const iso=t=>new Date(t).toISOString(),at=Date.parse('2026-10-12T09:00:00Z');
test('morning premium boundary is exact, previous close required, 13:00 releases only this guard',()=>{
 assert.equal(morningPremium(100,106.499,at).blocked,false);assert.equal(morningPremium(100,106.5,at).blocked,true);
 assert.equal(morningPremium(null,100,at).reason,'PREVIOUS_SESSION_CLOSE_MISSING');assert.equal(morningPremium(100,108,Date.parse('2026-10-12T10:00:00Z')).blocked,false);
});
const event=(strategy='SCALP')=>({strategy,captured_at:iso(at),metrics_json:JSON.stringify({initial_stop:98}),entry_quote_json:JSON.stringify({price:100,quote_time:iso(at-900000),received_at:iso(at),source:'YAHOO_INDICATIVE'})});
const bar=(n,high,low,open=100)=>({bar_time:iso(at+n*900000),received_at:iso(at+(n+1)*900000),open,high,low,close:100,volume:100});
test('counterfactual excludes pre-detection bar extremes; stop is final and fees included',()=>{
 const s=simulateOpportunity(event(),[bar(-1,150,50),bar(0,120,90),bar(1,150,100)],[],[],[],at+1800000);
 assert.equal(s.status,'CLOSED');assert.equal(s.exit.reason,'SL_NET_1_5');assert.equal(s.legs.length,1);assert.ok(s.pnl_net<0);assert.equal(s.remaining_lots,0);
 const clean=simulateOpportunity(event(),[bar(-1,150,50)],[],[],[],at+900000);assert.equal(clean.status,'OPEN');assert.equal(clean.legs.length,0);
});
test('TP1 runner uses later candle only; simulated state never mutates event',()=>{
 const e=event(),before=JSON.stringify(e),s=simulateOpportunity(e,[bar(0,105,100),bar(1,101,99)],[],[],[],at+1800000);
 assert.equal(s.status,'CLOSED');assert.equal(s.legs[0].reason,'SCALP_TP1');assert.equal(s.legs[1].reason,'SCALP_RUNNER_BE');assert.ok(s.pnl_net>0);assert.equal(JSON.stringify(e),before);
});
test('missing historic entry snapshot is visible rather than fabricated',()=>{
 assert.equal(simulateOpportunity({...event(),entry_quote_json:null},[],[]).status,'ENTRY_DATA_NOT_RECORDED');
});
test('Trend initial stop wins same candle and TP1/trailing retain remaining lots',()=>{
 const h=[{...bar(0,120,90),bar_time:iso(at),received_at:iso(at+3600000)}];
 const s=simulateOpportunity(event('SWING'),[],[],h,[],at+3600000);assert.equal(s.exit.reason,'TREND_INITIAL_STOP');assert.ok(s.pnl_net<0);
});
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {saveQuote} from '../worker/strategy_engines.mjs';
import {captureOpportunity,opportunitiesOverview,saveMarketContext,scalpPremiumGuard,capturePremium} from '../worker/opportunities.mjs';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'opp-')),path=join(dir,'db.sqlite'),adapter=new URL('./funnel_sqlite.py',import.meta.url).pathname;const call=x=>JSON.parse(execFileSync('python3',[adapter,path],{input:JSON.stringify(x),encoding:'utf8'}));call({init:true});const db={prepare(sql){return {sql,params:[],bind(...p){this.params=p;return this;},async all(){return call({statements:[this]})[0];},async first(){return (await this.all()).results[0]||null;},async run(){return this.all();}};},async batch(s){return call({statements:s});}};return {db,clean:()=>rmSync(dir,{recursive:true,force:true})};}
test('observed quote deduplication, day archive, and premium radar do not change cash or trades',async()=>{
 const {db,clean}=fixture();try{
 const q={symbol:'TUPRS',price:107,quote_time:iso(at-900000),source:'YAHOO_INDICATIVE'};
 await saveQuote(db,'TUPRS',q,at);await saveQuote(db,'TUPRS',q,at+1000);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM opportunity_quotes').first()).n,1);
 await saveMarketContext(db,'TUPRS',{close:100,bar_time:'2026-10-09T06:30:00Z',source:'YAHOO_INDICATIVE'},at);
 const guard=await scalpPremiumGuard(db,'TUPRS',107,at);assert.equal(guard.blocked,true);
 const metrics={rvol:3,last_candle:{close:107}},key='TUPRS:'+iso(at-1800000);
 await captureOpportunity(db,'SCALP','TUPRS',key,'HOT',iso(at-1800000),metrics,at);
 await capturePremium(db,'TUPRS',key,iso(at-1800000),metrics,guard,at);
 const before=await db.prepare('SELECT * FROM paper_cash_accounts').all(),view=await opportunitiesOverview(db,'2026-10-12',at+2000);
 assert.equal(view.high_momentum_radar.length,1);assert.equal(view.opportunities.length,1);assert.equal(view.opportunities[0].stages.length,2);assert.ok(view.opportunities[0].stages[0].scenario.executed_price>107);
 assert.deepEqual(await db.prepare('SELECT * FROM paper_cash_accounts').all(),before);assert.equal((await db.prepare('SELECT COUNT(*) n FROM virtual_trades').first()).n,0);
 // D1 itself blocks a morning insert even if another caller skips JS policy.
 await assert.rejects(db.prepare("INSERT INTO virtual_trades(strategy,symbol,status,engine_version,entry_time) VALUES('SCALP','TUPRS','OPEN',2,?)").bind(iso(at)).run());
 }finally{clean();}
});
test('production quota errors return a precise recoverable panel error, never an API-key claim',async()=>{
 const code=(await import('node:fs')).readFileSync(new URL('../worker/index.js',import.meta.url),'utf8');const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const response=await worker.fetch(new Request('https://panel.test/bist/connections',{headers:{Authorization:'Bearer test'}}),{ACCESS_TOKEN:'test',DB:{prepare(){throw Error("Your account has exceeded D1's free tier daily row read limit.");}}});assert.equal(response.status,503);const result=await response.json();assert.equal(result.error,'D1_DAILY_QUOTA_EXCEEDED');assert.match(result.message,/03:00 TRT/);
});
