import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validate, fresh, entryPlan, exitPlan, technicalSignal, ingest} from '../worker/cloud_bridge.mjs';
const now=Date.parse('2026-10-09T07:31:00Z');
const bar={symbol:'TUPRS',interval:'15m',time:'2026-10-09T07:00:00Z',open:100,high:101,low:99,close:100.5,volume:100};
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
 const rows=Array.from({length:20},()=>({time:bar.time,open:99,high:100,low:98,close:99,volume:100}));
 assert.equal(technicalSignal(rows),null);
 assert.equal(technicalSignal([...rows,{time:bar.time,open:100,high:104,low:100,close:103.5,volume:300}]).risk_verified,false);
});
test('stream body limit prevents DB write',async()=>{
 const response=await ingest(new Request('https://example.test/bist/feed/ingest',{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(100001)}),{DB:{}},now);
 assert.equal(response.status,413);
});
test('server runtime has no outbound fetch and compiled module matches tested source',()=>{
 const worker=readFileSync(new URL('../worker/index.js',import.meta.url),'utf8');
 const module=readFileSync(new URL('../worker/cloud_bridge.mjs',import.meta.url),'utf8').replace(/^export /gm,'');
 assert.ok(worker.startsWith(module));
 const server=worker.replace(/ const dashboard=String.raw`[\s\S]*?`;/,'');
 assert.doesNotMatch(server.replace('async fetch(request,env)', 'async handler(request,env)'),/\bfetch\s*\(/g); // method declaration below is exempted separately
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
