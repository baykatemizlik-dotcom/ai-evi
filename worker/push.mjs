// RFC 8291 payload encryption and RFC 8292 VAPID; no external packages or key logging.
import {json,readBody} from './cloud_bridge.mjs';
export const pushBytes=s=>new TextEncoder().encode(s);
export function pushB64(b){return btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
export function pushUnb64(s){if(typeof s!=='string'||! /^[A-Za-z0-9_-]+={0,2}$/.test(s))throw Error('INVALID_PUSH_KEY');return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
export function pushJoin(...parts){const out=new Uint8Array(parts.reduce((n,p)=>n+p.byteLength,0));let i=0;for(const p of parts){out.set(new Uint8Array(p),i);i+=p.byteLength;}return out;}
export function pushEndpoint(endpoint){const u=new URL(endpoint);if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!['web.push.apple.com','fcm.googleapis.com','updates.push.services.mozilla.com'].includes(u.hostname))throw Error('INVALID_PUSH_ENDPOINT');return u;}
export async function pushHKDF(secret,salt,info,size){const k=await crypto.subtle.importKey('raw',secret,'HKDF',false,['deriveBits']);return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},k,size*8));}
export async function pushEncrypt(sub,payload){
 const ua=pushUnb64(sub.p256dh),auth=pushUnb64(sub.auth);if(ua.length!==65||ua[0]!==4||auth.length!==16)throw Error('INVALID_PUSH_KEYS');
 const text=pushBytes(JSON.stringify(payload));if(text.length>3000)throw Error('PUSH_PAYLOAD_TOO_LARGE');
 const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
 const pub=new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey));
 const peer=await crypto.subtle.importKey('raw',ua,{name:'ECDH',namedCurve:'P-256'},false,[]);
 const shared=await crypto.subtle.deriveBits({name:'ECDH',public:peer},pair.privateKey,256);
 const ikm=await pushHKDF(shared,auth,pushJoin(pushBytes('WebPush: info\u0000'),ua,pub),32),salt=crypto.getRandomValues(new Uint8Array(16));
 const cek=await pushHKDF(ikm,salt,pushBytes('Content-Encoding: aes128gcm\u0000'),16),nonce=await pushHKDF(ikm,salt,pushBytes('Content-Encoding: nonce\u0000'),12);
 const key=await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['encrypt']);
 const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},key,pushJoin(text,Uint8Array.of(2)));
 const rs=new Uint8Array(4);new DataView(rs.buffer).setUint32(0,4096);
 return pushJoin(salt,rs,Uint8Array.of(pub.length),pub,encrypted);
}
export async function pushAuthorization(env,endpoint,now=Date.now()){
 const aud=pushEndpoint(endpoint).origin,jwk=JSON.parse(env.VAPID_PRIVATE_JWK);
 const header=pushB64(pushBytes(JSON.stringify({typ:'JWT',alg:'ES256'})));
 const claims=pushB64(pushBytes(JSON.stringify({aud,exp:Math.floor(now/1000)+3600,sub:'https://ai-evi.baykatemizlik.workers.dev'})));
 const key=await crypto.subtle.importKey('jwk',jwk,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
 const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,pushBytes(header+'.'+claims));
 return 'vapid t='+header+'.'+claims+'.'+pushB64(signature)+', k='+env.VAPID_PUBLIC_KEY;
}
export async function sendWebPush(env,sub,payload,network=(...args)=>globalThis.fetch(...args)){
 pushEndpoint(sub.endpoint);
 const body=await pushEncrypt(sub,payload),authorization=await pushAuthorization(env,sub.endpoint);
 const response=await network(sub.endpoint,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{Authorization:authorization,TTL:'300',Urgency:'normal','Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream'},body});
 const status=response.status;await response.body?.cancel();return status;
}
export async function pushStatus(env){const sub=await env.DB.prepare('SELECT COUNT(*) n FROM push_subscriptions').first();const counts=await env.DB.prepare('SELECT status,COUNT(*) n FROM bist_push_deliveries GROUP BY status').all();return {configured:!!(env.VAPID_PUBLIC_KEY&&env.VAPID_PRIVATE_JWK),subscribers:sub.n,deliveries:counts.results||[]};}
export async function pushRoute(request,env){
 const path=new URL(request.url).pathname;
 if(path==='/push/key'&&request.method==='GET')return json({key:env.VAPID_PUBLIC_KEY||null,enabled:!!(env.VAPID_PUBLIC_KEY&&env.VAPID_PRIVATE_JWK)},env.VAPID_PUBLIC_KEY&&env.VAPID_PRIVATE_JWK?200:503);
 if(path==='/push/status'&&request.method==='GET')return json(await pushStatus(env));
 if(!['/push/subscribe','/push/test'].includes(path)||request.method!=='POST')return json({error:'METHOD_NOT_ALLOWED'},405);
 if(!env.VAPID_PUBLIC_KEY||!env.VAPID_PRIVATE_JWK)return json({error:'PUSH_NOT_CONFIGURED'},503);
 let b;try{b=await readBody(request);pushEndpoint(b.endpoint);}catch{return json({error:'INVALID_SUBSCRIPTION'},422);}
 if(path==='/push/subscribe'){
  try{const pub=pushUnb64(b.keys?.p256dh),auth=pushUnb64(b.keys?.auth);if(b.endpoint.length>2000||pub.length!==65||pub[0]!==4||auth.length!==16)throw Error();await crypto.subtle.importKey('raw',pub,{name:'ECDH',namedCurve:'P-256'},false,[]);}catch{return json({error:'INVALID_SUBSCRIPTION_KEYS'},422);}
  await env.DB.prepare('INSERT INTO push_subscriptions(endpoint,p256dh,auth,created_at) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth').bind(b.endpoint,b.keys.p256dh,b.keys.auth,new Date().toISOString()).run();return json({ok:true});
 }
 const sub=await env.DB.prepare('SELECT * FROM push_subscriptions WHERE endpoint=?').bind(b.endpoint).first();if(!sub)return json({error:'SUBSCRIPTION_NOT_FOUND'},404);
 try{const status=await sendWebPush(env,sub,{title:'BIST · Test bildirimi',body:'Bildirim bağlantısı çalışıyor. İşlemler sanaldır.',tag:'bist-test-'+Date.now()});if([404,410].includes(status))await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(sub.endpoint).run();return json({accepted:status>=200&&status<300,provider_status:status},status>=200&&status<300?200:502);}catch{return json({error:'PUSH_SEND_FAILED'},502);}
}
export async function drainPush(env,now=Date.now(),network=(...args)=>globalThis.fetch(...args)){
 if(!env.VAPID_PUBLIC_KEY||!env.VAPID_PRIVATE_JWK)return {sent:0,configured:false};
 const stamp=new Date(now).toISOString();
 await env.DB.prepare("INSERT OR IGNORE INTO bist_push_deliveries(event_id,endpoint,status,attempts,next_attempt) SELECT e.id,s.endpoint,'PENDING',0,? FROM bist_push_events e CROSS JOIN push_subscriptions s WHERE e.created_at>=s.created_at AND e.expires_at>? ").bind(stamp,stamp).run();
 const rows=await env.DB.prepare("SELECT d.*,e.payload_json,s.p256dh,s.auth FROM bist_push_deliveries d JOIN bist_push_events e ON e.id=d.event_id JOIN push_subscriptions s ON s.endpoint=d.endpoint WHERE d.status IN('PENDING','ERROR','SENDING') AND d.attempts<5 AND d.next_attempt<=? AND (d.lease_until IS NULL OR d.lease_until<=?) AND e.expires_at>? ORDER BY e.created_at LIMIT 5").bind(stamp,stamp,stamp).all();let sent=0;
 for(const d of rows.results||[]){
  const lease=new Date(now+90000).toISOString();const claim=await env.DB.prepare("UPDATE bist_push_deliveries SET status='SENDING',attempts=attempts+1,lease_until=? WHERE event_id=? AND endpoint=? AND status IN('PENDING','ERROR','SENDING') AND (lease_until IS NULL OR lease_until<=?)").bind(lease,d.event_id,d.endpoint,stamp).run();if(!claim.meta.changes)continue;
  let status=0;try{status=await sendWebPush(env,d,JSON.parse(d.payload_json),network);}catch{}
  const ok=status>=200&&status<300,dead=[404,410].includes(status);
  await env.DB.prepare('UPDATE bist_push_deliveries SET status=?,provider_status=?,lease_until=NULL,next_attempt=? WHERE event_id=? AND endpoint=?').bind(ok?'SENT':dead?'DEAD':'ERROR',status,new Date(now+Math.min(300000,60000*(d.attempts+1))).toISOString(),d.event_id,d.endpoint).run();
  if(dead)await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(d.endpoint).run();if(ok)sent++;
 }
 return {sent};
}
