import test from 'node:test';
import assert from 'node:assert/strict';
import {trialFeed,trialOverview} from '../worker/trial_engines.mjs';

test('trial feed CAS, immutable history, and isolated namespace',async()=>{
 const s={initial_cash:'25000',cash:'25000',arm:'V4QQ',paper_only:true,mode:'YAHOO_DELAYED_PAPER_ADAPTATION',activation_epoch:1,source_start_minute:2,cursor:null,ledger:[],open_trades:[],closed_trades:[],status:'WAITING_TODAY_DATA'};
 const row={id:'DENEME_1',revision:0,state_json:JSON.stringify(s),updated_at:'x'};const sqls=[];
 const db={prepare(sql){sqls.push(sql);return {args:[],bind(...a){this.args=a;return this;},async first(){return row;},async all(){return {results:[row]};},async run(){if(this.args[2]!==row.revision)return {meta:{changes:0}};row.state_json=this.args[0];row.revision++;return {meta:{changes:1}};}};}};
 const req=b=>new Request('https://test/bist/feed/trials',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
 assert.equal((await trialFeed(req({id:'SCALP',expected_revision:0,state:s}),{DB:db})).status,422);
 assert.equal((await trialFeed(req({id:'DENEME_1',expected_revision:0,state:s}),{DB:db})).status,200);
 assert.equal((await trialFeed(req({id:'DENEME_1',expected_revision:0,state:s}),{DB:db})).status,409);
 assert.equal((await trialFeed(req({id:'DENEME_1',expected_revision:1,state:{...s,activation_epoch:3}}),{DB:db})).status,422);
 assert.equal((await trialOverview(db)).bots[0].ledger,undefined);
 assert.ok(sqls.every(x=>x.includes('research_paper_trials')));
});
