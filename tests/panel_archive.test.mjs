import test from 'node:test';import assert from 'node:assert/strict';
import {archivedPanelValue,panelArchiveRead} from '../worker/panel_archive.mjs';
import {reconstructOpportunity} from '../worker/opportunities.mjs';
import {readFileSync} from 'node:fs';import {Script,createContext} from 'node:vm';import {webcrypto} from 'node:crypto';
const now=Date.parse('2026-10-12T10:00:00Z');
test('quota fallback keeps recorded times and cash, marks prices and providers historical',async()=>{
 const saved={captured_at:'2026-10-12T09:55:00Z',data:{server_time:'2026-10-12T09:22:00Z',scalp_cash:21,status:'ACTIVE',scanner_live:true,open_trades:[{quote_fresh:true,quote_time:'2026-10-12T08:30:00Z'}],gemini:{connection:'CONNECTED',last_decision:{status:'APPROVED'}},bots:[{status:'RUNNING_DELAYED_PAPER'}]}};
 const before=JSON.stringify(saved),d=archivedPanelValue(saved,now);assert.equal(d.scalp_cash,21);assert.equal(d.server_time,saved.data.server_time);assert.equal(d.scanner_live,false);assert.equal(d.open_trades[0].quote_fresh,false);assert.equal(d.gemini.connection,'ARCHIVED_STATUS');assert.equal(d.bots[0].panel_stale,true);assert.equal(JSON.stringify(saved),before);
 let queried=false;const env={PANEL_ARCHIVE:{get:async k=>k==='quota_until'?String(now+1000):saved}};
 const r=await panelArchiveRead(env,'overview',()=>{queried=true;},now);assert.equal(r.status,200);assert.equal((await r.json()).panel_archived,true);assert.equal(queried,false);
});
test('quota fallback missing snapshot returns 503; non-quota errors propagate',async()=>{
 const env={PANEL_ARCHIVE:{get:async()=>null,put:async()=>{}}};assert.equal((await panelArchiveRead(env,'overview',()=>{throw Error('daily row read limit');},now)).status,503);
 await assert.rejects(panelArchiveRead(env,'overview',()=>{throw Error('SQL_ERROR');},now),/SQL_ERROR/);
});
test('historical next-minute entry is explicitly retrospective, includes costs, never changes original event',()=>{
 const e={event_key:'x',symbol:'TEST',strategy:'SCALP',captured_at:'2026-10-12T09:00:45Z',metrics_json:'{}',entry_quote_json:null};
 const entry={price:100,bar_time:'2026-10-12T09:01:00Z',interval:'1m',source:'YAHOO_HISTORICAL_NEXT_MINUTE_OPEN',retrieved_at:'2026-10-12T10:00:00Z'},r={entries:{x:entry},history:{TEST:{'1m':[],'15m':[],'60m':[]}}};
 const before=JSON.stringify(e),s=reconstructOpportunity(e,r,now);assert.equal(s.retrospective,true);assert.equal(s.executed_price,100.2);assert.equal(s.entry_time,entry.bar_time);assert.equal(s.original_found_at,e.captured_at);assert.equal(JSON.stringify(e),before);
 assert.equal(reconstructOpportunity(e,{...r,entries:{x:{...entry,bar_time:'2026-10-12T09:00:00Z'}}},now).status,'ENTRY_DATA_NOT_RECORDED');
 assert.equal(reconstructOpportunity(e,{...r,entries:{x:{...entry,bar_time:'2026-10-12T09:05:00Z'}}},now).status,'ENTRY_DATA_NOT_RECORDED');
});
test('archive remains behind existing auth and cannot serve feed or trading operations',async()=>{
 const source=readFileSync(new URL('../worker/index.js',import.meta.url),'utf8').replace('export default {','globalThis.worker={');
 const ctx=createContext({crypto:webcrypto,TextEncoder,TextDecoder,Response,Request,URL,setTimeout,clearTimeout});new Script(source).runInContext(ctx);
 const env={ACCESS_TOKEN:'unit-test-secret',PANEL_ARCHIVE:{get:async k=>k==='quota_until'?String(Date.now()+60000):{captured_at:new Date().toISOString(),data:{scalp_cash:21,open_trades:[]}}},DB:{prepare(){throw Error('daily row read limit');}}};
 const denied=await ctx.worker.fetch(new Request('https://panel.test/bist/overview'),env);assert.equal(denied.status,401);
 const allowed=await ctx.worker.fetch(new Request('https://panel.test/bist/overview',{headers:{Authorization:'Bearer unit-test-secret'}}),env);assert.equal(allowed.status,200);assert.equal((await allowed.json()).panel_archived,true);
 const feed=await ctx.worker.fetch(new Request('https://panel.test/bist/feed/monitor',{headers:{Authorization:'Bearer unit-test-secret'}}),env);assert.equal(feed.status,503);assert.equal((await feed.json()).panel_archived,undefined);
});
