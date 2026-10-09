import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {pushB64,pushBytes,pushJoin,pushHKDF,pushEncrypt,pushAuthorization,pushEndpoint,sendWebPush,drainPush} from '../worker/push.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
test('push configuration stays authenticated; cross-origin subscription writes are rejected',async()=>{
 const {readFileSync}=await import('node:fs');const code=readFileSync(new URL('../worker/index.js',import.meta.url),'utf8');
 const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const env={ACCESS_TOKEN:'push-unit-only',VAPID_PUBLIC_KEY:'public-test',VAPID_PRIVATE_JWK:'private-test'};
 assert.equal((await worker.fetch(new Request('https://example.test/push/key'),env)).status,401);
 const r=await worker.fetch(new Request('https://example.test/push/key',{headers:{Authorization:'Bearer push-unit-only'}}),env);
 assert.equal(r.status,200);assert.equal((await r.json()).key,'public-test');
 const cross=await worker.fetch(new Request('https://example.test/push/subscribe',{method:'POST',headers:{Authorization:'Bearer push-unit-only',Origin:'https://evil.test','Content-Type':'application/json'},body:'{}'}),env);assert.equal(cross.status,403);
});
test('outbox sends once, retries failures, and removes expired device subscriptions',async()=>{
 const {mkdtempSync,rmSync,readFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'push-test-')),path=join(dir,'db.sqlite');
 const migration=readFileSync(new URL('../migrations/0016_web_push.sql',import.meta.url),'utf8');
 execFileSync('python3',['-c',"import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);d.executescript('CREATE TABLE bist_feed_signals(status,symbol,signal_key,expires_at);CREATE TABLE virtual_trades(id,feed_entry_key,status,symbol,strategy,lot_count,executed_price,exit_reason,pnl_net);'+sys.stdin.read());d.commit()",path],{input:migration});
 const adapter=new URL('./funnel_sqlite.py',import.meta.url).pathname;
 const call=data=>JSON.parse(execFileSync('python3',[adapter,path],{input:JSON.stringify(data),encoding:'utf8'}));
 const db={prepare(sql){return {sql,params:[],bind(...p){this.params=p;return this;},async all(){return call({statements:[this]})[0];},async first(){return (await this.all()).results[0]||null;},async run(){return await this.all();}};}};
 try{
  const vapid=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const ec=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const env={DB:db,VAPID_PRIVATE_JWK:JSON.stringify(await crypto.subtle.exportKey('jwk',vapid.privateKey)),VAPID_PUBLIC_KEY:pushB64(await crypto.subtle.exportKey('raw',vapid.publicKey))};
  const endpoint='https://web.push.apple.com/test';const now=Date.parse('2026-10-09T12:00:00Z');
  await db.prepare('INSERT INTO push_subscriptions VALUES(?,?,?,?)').bind(endpoint,pushB64(await crypto.subtle.exportKey('raw',ec.publicKey)),pushB64(new Uint8Array(16)),'2026-10-09T11:00:00Z').run();
  await db.prepare('INSERT INTO bist_push_events VALUES(?,?,?,?)').bind('test-1',JSON.stringify({title:'test'}),'2026-10-09T11:59:00Z','2026-10-09T12:10:00Z').run();
  let sends=0;const success=async()=>{sends++;return new Response(null,{status:201});};
  assert.equal((await drainPush(env,now,success)).sent,1);assert.equal((await drainPush(env,now+1000,success)).sent,0);assert.equal(sends,1);
  await db.prepare('INSERT INTO bist_push_events VALUES(?,?,?,?)').bind('test-2',JSON.stringify({title:'retry'}),'2026-10-09T12:01:00Z','2026-10-09T12:10:00Z').run();
  await drainPush(env,now+60000,async()=>new Response(null,{status:503}));assert.equal((await db.prepare("SELECT status FROM bist_push_deliveries WHERE event_id='test-2'").first()).status,'ERROR');
  await drainPush(env,now+120000,async()=>new Response(null,{status:410}));assert.equal((await db.prepare('SELECT COUNT(*) n FROM push_subscriptions').first()).n,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Web Push encrypts a payload decryptable by a separate recipient key',async()=>{
 const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
 const ua=new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)),auth=crypto.getRandomValues(new Uint8Array(16));
 const sub={endpoint:'https://web.push.apple.com/test',p256dh:pushB64(ua),auth:pushB64(auth)},payload={title:'BIST',body:'Sanal alım · test'};
 const wire=await pushEncrypt(sub,payload),salt=wire.slice(0,16),pub=wire.slice(21,86);
 assert.equal(new DataView(wire.buffer).getUint32(16),4096);assert.equal(wire[20],65);
 const peer=await crypto.subtle.importKey('raw',pub,{name:'ECDH',namedCurve:'P-256'},false,[]);
 const shared=await crypto.subtle.deriveBits({name:'ECDH',public:peer},pair.privateKey,256);
 const ikm=await pushHKDF(shared,auth,pushJoin(pushBytes('WebPush: info\u0000'),ua,pub),32);
 const cek=await pushHKDF(ikm,salt,pushBytes('Content-Encoding: aes128gcm\u0000'),16),nonce=await pushHKDF(ikm,salt,pushBytes('Content-Encoding: nonce\u0000'),12);
 const key=await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['decrypt']);
 const plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce},key,wire.slice(86)));
 assert.equal(plain.at(-1),2);assert.deepEqual(JSON.parse(new TextDecoder().decode(plain.slice(0,-1))),payload);
});
test('VAPID JWT signature and audience verify; no redirects; rejects untrusted endpoints',async()=>{
 const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const env={VAPID_PRIVATE_JWK:JSON.stringify(await crypto.subtle.exportKey('jwk',pair.privateKey)),VAPID_PUBLIC_KEY:pushB64(await crypto.subtle.exportKey('raw',pair.publicKey))};
 const now=Date.parse('2026-10-09T12:00:00Z'),authorization=await pushAuthorization(env,'https://web.push.apple.com/test',now);
 const jwt=authorization.split('t=')[1].split(',')[0],[h,p,s]=jwt.split('.');
 const decode=x=>Buffer.from(x,'base64url');
 assert.equal(JSON.parse(decode(p)).aud,'https://web.push.apple.com');assert.equal(JSON.parse(decode(p)).exp,Math.floor(now/1000)+3600);
 assert.equal(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pair.publicKey,decode(s),pushBytes(h+'.'+p)),true);
 for(const bad of ['http://web.push.apple.com/x','https://web.push.apple.com.evil.test/x','https://user@web.push.apple.com/x','https://127.0.0.1/x'])assert.throws(()=>pushEndpoint(bad));
 const ec=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
 const sub={endpoint:'https://web.push.apple.com/test',p256dh:pushB64(await crypto.subtle.exportKey('raw',ec.publicKey)),auth:pushB64(new Uint8Array(16))};
 const status=await sendWebPush(env,sub,{title:'test'},async(url,options)=>{assert.equal(options.redirect,'manual');assert.equal(options.headers['Content-Encoding'],'aes128gcm');assert.ok(options.body.length>100);return new Response(null,{status:201});});assert.equal(status,201);
});
