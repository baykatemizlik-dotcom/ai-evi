import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {startDemo20261012} from '../worker/strategy_engines.mjs';

test('authorised native D1 reset preserves archive, sets 25k once, and rejects wrong confirmation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'demo-reset-'));try{
 const path=join(dir,'db.sqlite'),adapter=new URL('./funnel_sqlite.py',import.meta.url).pathname;
 const call=x=>JSON.parse(execFileSync('python3',[adapter,path],{input:JSON.stringify(x),encoding:'utf8'}));call({init:true});
 const db={prepare(sql){return {sql,params:[],bind(...params){this.params=params;return this;},async all(){return call({statements:[this]})[0];},async first(){return (await this.all()).results[0]||null;},async run(){return this.all();}};},async batch(statements){return call({statements});}};
 await db.prepare('CREATE TABLE bist_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT)').run();
 for(let i=0;i<9;i++)await db.prepare("INSERT INTO virtual_trades(strategy,symbol,signal_price,executed_price,lot_count,commission,entry_time,status,remaining_lots,engine_version) VALUES('SCALP','TEST',100,100,4,1,'2026-10-09T12:00:00Z','OPEN',4,1)").run();
 await db.prepare('CREATE TABLE demo_20261012_before_virtual_trades AS SELECT * FROM virtual_trades').run();
 const request=body=>new Request('https://example.test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await startDemo20261012(request({total_capital:25000,confirmation:'wrong'}),{DB:db})).status,422);
 const body={total_capital:25000,confirmation:'ARCHIVE_OLD_DEMO_AND_RESET_20261012'};
 assert.equal((await (await startDemo20261012(request(body),{DB:db})).json()).ok,true);
 assert.equal((await db.prepare('SELECT SUM(available_cash) n FROM paper_cash_accounts').first()).n,25000);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM virtual_trades').first()).n,0);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM demo_20261012_before_virtual_trades WHERE status=\'OPEN\' AND exit_price IS NULL').first()).n,9);
 assert.equal((await (await startDemo20261012(request(body),{DB:db})).json()).already_applied,true);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM demo_20261012_reset_applied').first()).n,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
