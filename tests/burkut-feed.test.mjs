import test from 'node:test';import assert from 'node:assert/strict';
import {collectBurkut,priceRows} from '../worker/burkut-feed.mjs';
import {NEWS_COMPANIES} from '../worker/news-catalog.mjs';
test('snapshot remains price-only and records official veto, one call per minute',async()=>{
 let last=-1,count=0,calls=0,saved;const db={prepare(sql){let args;return {bind(...a){args=a;return this;},async run(){if(sql.startsWith('UPDATE')){if(args[0]<=last||count>=900)return {meta:{changes:0}};last=args[0];count++;}return {meta:{changes:1}};},async first(){return {attempts:count};},async all(){return {results:[{symbol:'THYAO'}]};}};}};
 const env={BURKUT_API_KEY:'test',DB:db,PANEL_ARCHIVE:{async put(key,value){if(key==='burkut:price-radar')saved=JSON.parse(value);}}};
 const data=Object.keys(NEWS_COMPANIES).slice(0,110).concat('THYAO').map(symbol=>({symbol,price:10,changePercent:2,volume:20000000,updatedAt:'2026-10-13T07:00:00Z'}));
 const network=async(url,o)=>{calls++;assert.equal(o.redirect,'manual');return new Response(JSON.stringify({data}));};const time=Date.parse('2026-10-13T07:01:00Z');
 await collectBurkut(env,time,network);await collectBurkut(env,time,network);assert.equal(calls,1);assert.equal(saved.can_generate_order,false);assert.equal(saved.intraday_bars_verified,false);assert.ok(saved.watch.some(r=>r.symbol==='THYAO'&&r.risk==='OFFICIAL_BLACKLIST'));count=900;await collectBurkut(env,time+60000,network);assert.equal(calls,1);
});
test('invalid prices and unknown symbols cannot appear in watch data',()=>{assert.deepEqual(priceRows([{symbol:'THYAO',price:-1,changePercent:5,volume:1},{symbol:'FAKE',price:1,changePercent:5,volume:1}]),[]);});
