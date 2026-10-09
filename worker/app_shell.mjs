const reply=json;
const hash=async value=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
const secureEqual=async(a,b)=>{const[x,y]=await Promise.all([hash(a),hash(b)]);let d=0;for(let i=0;i<x.length;i++)d|=x[i]^y[i];return d===0;};
export default {async fetch(request,env){
 const u=new URL(request.url);
 const dashboard=String.raw`@@DASHBOARD@@`;
 if((u.pathname==="/"||u.pathname==="/bist")&&request.method==="GET")return new Response(dashboard,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"}});
 if(u.pathname==="/manifest.json")return new Response(JSON.stringify({name:"BIST AVCI",short_name:"BIST AVCI",start_url:"/",scope:"/",display:"standalone",background_color:"#0c1220",theme_color:"#0c1220",icons:[{src:"/icon.svg",sizes:"any",type:"image/svg+xml",purpose:"any maskable"}]}),{headers:{"Content-Type":"application/manifest+json","Cache-Control":"max-age=300"}});
 if(u.pathname==="/icon.svg")return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192"><rect width="192" height="192" rx="36" fill="#0c1220"/><path d="M30 140 L65 105 L92 121 L135 59 L165 72" fill="none" stroke="#58d0a0" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/><text x="26" y="50" fill="white" font-size="27" font-family="sans-serif">BIST</text></svg>',{headers:{"Content-Type":"image/svg+xml","Cache-Control":"max-age=86400"}});
 if(u.pathname==="/sw.js")return new Response("self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('push',e=>{let x={title:'BIST AVCI',body:'Yeni doğrulanmış sinyal var. Paneli açıp kontrol et.'};try{if(e.data)x={...x,...e.data.json()}}catch{}e.waitUntil(self.registration.showNotification(x.title,{body:x.body,icon:'/icon.svg',tag:x.tag||'bist-signal',data:{url:'/'}}))});self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(self.clients.openWindow('/'))})",{headers:{"Content-Type":"application/javascript","Service-Worker-Allowed":"/","Cache-Control":"no-cache"}});
 const bearer=request.headers.get("Authorization")||"";
 const provided=bearer.startsWith("Bearer ")?bearer.slice(7):"";
 const constantEqual=(x,y)=>{if(x.length!==y.length)return false;let d=0;for(let i=0;i<x.length;i++)d|=x.charCodeAt(i)^y.charCodeAt(i);return d===0};
 const key=env.ACCESS_TOKEN?await crypto.subtle.importKey("raw",new TextEncoder().encode(env.ACCESS_TOKEN),{name:"HMAC",hash:"SHA-256"},false,["sign"]):null;
 const sign=async msg=>{const bytes=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(msg)));return [...bytes].map(x=>x.toString(16).padStart(2,"0")).join("")};
 const cookies=request.headers.get("Cookie")||"";
 const session=(cookies.match(/(?:^|;\s*)bist_session=([^;]+)/)||[])[1]||"";
 let authenticated=false;
 if(provided&&env.ACCESS_TOKEN){const [a,b]=await Promise.all([hash(provided),hash(env.ACCESS_TOKEN)]);let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];authenticated=diff===0}
 if(!authenticated&&key&&session){const [exp,sig]=session.split(".");const n=Number(exp);if(/^\d{10,13}$/.test(exp||"")&&n>Date.now()&&n<Date.now()+15*86400000&&/^[a-f0-9]{64}$/.test(sig||""))authenticated=constantEqual(sig,await sign(exp))}
 if(u.pathname==="/bist/session"&&request.method==="POST"){
   if(!authenticated||!provided)return reply({error:"Invalid access token"},401);
   const exp=String(Date.now()+14*86400000);
   return new Response(JSON.stringify({ok:true,expires_at:new Date(Number(exp)).toISOString()}),{status:200,headers:{"Content-Type":"application/json","Cache-Control":"no-store","Set-Cookie":"bist_session="+exp+"."+await sign(exp)+"; Max-Age=1209600; Path=/; HttpOnly; Secure; SameSite=Strict"}});
 }
 if(u.pathname==="/bist/logout"&&request.method==="POST")return new Response(JSON.stringify({ok:true}),{headers:{"Content-Type":"application/json","Set-Cookie":"bist_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict"}});
 if(['/bist/feed/trend','/bist/feed/quote','/bist/feed/trend-universe','/bist/feed/ingest','/bist/feed/risk','/bist/feed/monitor','/bist/feed/report','/bist/feed/finalize','/bist/feed/daily','/bist/feed/audit','/bist/feed/probe','/bist/feed/gemini'].includes(u.pathname)){
  if(u.pathname==='/bist/feed/gemini'?!['GET','POST'].includes(request.method):['/bist/feed/monitor','/bist/feed/daily','/bist/feed/trend-universe'].includes(u.pathname)?request.method!=='GET':request.method!=='POST')return reply({error:'METHOD_NOT_ALLOWED'},405);
  const ingestToken=env.BIST_INGEST_TOKEN||env.ACCESS_TOKEN;
  if(!ingestToken)return reply({error:'INGEST_TOKEN_NOT_CONFIGURED'},503);
  if(!provided || !await secureEqual(provided,ingestToken))return reply({error:'Unauthorized'},401);
  try{if(u.pathname.endsWith('/trend-universe'))return await trendUniverse(env.DB);
   if(u.pathname.endsWith('/quote'))return await quoteIngest(request,env);
   if(u.pathname.endsWith('/trend'))return await trendIngest(request,env);
   if(u.pathname.endsWith('/gemini'))return await geminiDecision(request,env);
   if(u.pathname.endsWith('/probe'))return await probeMini(env);
   if(u.pathname.endsWith('/daily'))return reply(await dailyReport(env.DB));
   if(u.pathname.endsWith('/audit'))return await externalAudit(request,env);
   if(u.pathname.endsWith('/monitor'))return await monitorSymbols(env);
   if(u.pathname.endsWith('/risk'))return await riskIngest(request,env);
   if(u.pathname.endsWith('/report'))return await reportIngest(request,env);
   if(u.pathname.endsWith('/finalize'))return await finalize(request,env);
   return await ingest(request,env);}catch{return reply({error:'INGEST_OR_ENGINE_FAILED',retry_safe:true},503);}
 }
 if(!authenticated)return reply({error:"Unauthorized"},401);
 if(u.pathname.startsWith('/push/')){if(request.method==='POST'&&request.headers.get('Origin')&&request.headers.get('Origin')!==u.origin)return reply({error:'INVALID_ORIGIN'},403);return await pushRoute(request,env);}

 if(u.pathname==='/bist/status'||u.pathname==='/bist/bridge/status')return reply(await feedStatus(env.DB));
 if(u.pathname==='/bist/connections')return reply({mode:'CLOUD_BRIDGE_AI_REFEREE',external_fetch_enabled:true,market_data_fetch_enabled:false,gemini:await geminiStatus(env),openai:await aiStatus(env)});
 if(u.pathname==='/bist/ai/decisions')return reply({decisions:(await env.DB.prepare('SELECT symbol,bar_time,model,status,reason,completed_at,confidence,input_tokens,output_tokens FROM bist_ai_decisions ORDER BY created_at DESC LIMIT 100').all()).results});
 if(u.pathname==='/bist/report'){const report=await dailyReport(env.DB);const audit=await env.DB.prepare('SELECT * FROM bist_external_audits ORDER BY trt_date DESC LIMIT 1').first();return reply({...report,external_audit:audit?{...audit,report:JSON.parse(audit.report_json)}:null});}
 if(u.pathname==='/bist/overview')return reply({...await isolatedOverview(env.DB),gemini:await geminiStatus(env)});
 if(u.pathname==='/bist/strategy/berker3'){if(request.method==='POST'&&request.headers.get('Origin')&&request.headers.get('Origin')!==u.origin)return reply({error:'INVALID_ORIGIN'},403);try{return await berker3Route(request,env);}catch{return reply({error:'LIST_UPDATE_FAILED'},503);}}
 if(u.pathname==='/bist/strategy/close'){
  if(request.method!=='POST')return reply({error:'METHOD_NOT_ALLOWED'},405);
  if(request.headers.get('Origin')&&request.headers.get('Origin')!==u.origin)return reply({error:'INVALID_ORIGIN'},403);
  try{return await manualStrategyClose(request,env);}catch{return reply({error:'CLOSE_FAILED',retry_safe:true},503);}
 }
 return reply({error:'DISABLED_IN_INGRESS_ONLY_MODE',external_fetch_enabled:false},410);
},async scheduled(controller,env){const result=await enforceSessionClose(env.DB,Date.now());try{return {...result,push:await drainPush(env)};}catch{return {...result,push:{error:'DISPATCH_FAILED'}};}}};
