// Run: node --test v05/test/source.test.mjs (no API keys, DB or network required)
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const worker=readFileSync(new URL('../worker.js',import.meta.url),'utf8');
const ui=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const backup=readFileSync(new URL('../backup-worker.js',import.meta.url),'utf8');
test('All modules parse',async()=>{
 await import('../worker.js');
 await import('../backup-worker.js');
 new Function(ui.split('<script>')[1].split('</script>')[0]);
});
test('Atomik D1 kilidi model isteğinden önce',()=>{
 assert.match(worker,/UPDATE conversations SET status='RUNNING'.*RETURNING id/);
 assert.ok(worker.indexOf('const claimed=await env.DB.prepare')<worker.indexOf('const value=isGPT?await openai'));
 assert.match(worker,/if\(!claimed\)return json\(/);
});
test('Ekonomi ve başarısız Gemini koşulları',()=>{
 assert.match(worker,/stage==="GEMINI_REVIEW" && value.agree===true/);
 assert.match(worker,/elapsed<60\*60\*1000/);
 assert.match(worker,/NEEDS_MANUAL_REVIEW/);
});
test('D1 olay ve karar hatırlama rotaları',()=>{
 assert.match(worker,/INSERT OR IGNORE INTO conversation_events/);
 assert.match(worker,/url.pathname==="\/v05\/decisions"/);
});
test('Mobil refresh sonrası konuşma ID kalır',()=>{
 assert.match(ui,/localStorage.getItem\("ai_evi_v05_test_id"\)/);
 assert.match(ui,/\/v05\/status\?id=/);
});
test('Yedekler günde bir kereden fazla yazılmaz',()=>{
 assert.match(backup,/BACKUPS.head\(key\)/);
 assert.match(backup,/BACKUPS.put\(key,body/);
});
