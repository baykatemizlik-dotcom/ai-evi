// BIST AVCI research-only Cloudflare Worker. No AI Evi routes.
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
const hash=async s=>new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s)));
export default {async fetch(request,env){
 const u=new URL(request.url);
 const dashboard=String.raw`<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>BIST AVCI</title><style>body{margin:0;background:#0c1220;color:#f3f6ff;font:16px system-ui;padding:22px}main{max-width:660px;margin:auto}section{background:#192335;border:1px solid #2b394e;border-radius:18px;padding:18px;margin-top:16px}h1{margin:22px 0 0}small,p{color:#bac8d9}input,button{box-sizing:border-box;width:100%;border-radius:12px;padding:15px;margin:8px 0;background:#0c1220;border:1px solid #52677e;color:#fff;font-size:16px}button{background:#247c65;border:0;font-weight:bold}button:disabled{opacity:.6}pre{white-space:pre-wrap;word-break:break-word;background:#0c1220;border-radius:12px;padding:14px}a{color:#8cdbda}</style><main><h1>📈 BIST AVCI</h1><p>Cloudflare araştırma servisi • Gerçek emir göndermez</p><section><h2>Canlı servis</h2><p id="health">Worker erişilebilir. Yetkili test henüz yapılmadı.</p><p>Teknik hisse tarayıcısı ve otomatik bildirimler henüz yayında değil.</p></section><section><h2>API bağlantı kontrolü</h2><p>Anahtarları açığa çıkarmadan Gemini ve OpenAI API erişimini sınar. Başarılı bağlantı araştırma kotasının açık olduğunu garanti etmez.</p><button id="check">🔌 Bağlantıları Test Et</button><pre id="checkResult">Henüz test edilmedi.</pre></section><section><h2>Gemini üretim testi</h2><p>İki test de küçük bir API isteği yapar, günlük araştırma limitini kullanmaz. Google kotasını kullanabilir.</p><button id="plain">🧪 Basit Test (Aramasız)</button><button id="ground">🔎 Google Search Testi</button><pre id="testResult">Henüz test edilmedi.</pre></section><section><h2>Gemini haber araştırması</h2><p>Bu alan yalnız mevcut ACCESS_TOKEN ile çalışır. Token tarayıcıda saklanmaz, sunucuya Authorization başlığında gönderilir.</p><input id="token" type="password" autocomplete="off" placeholder="Mevcut erişim tokenı"><input id="symbol" value="ASTOR" maxlength="6" autocapitalize="characters" placeholder="Hisse kodu"><button id="go">Araştır</button><pre id="result">Henüz sorgu yapılmadı.</pre></section><p><small>Google Search sonuçları resmî KAP teyidi değildir. Günlük 20 araştırma limiti vardır.</small></p></main><script>const go=document.getElementById('go'),out=document.getElementById('result');document.getElementById('check').addEventListener('click',async()=>{const token=document.getElementById('token').value;if(!token){document.getElementById('checkResult').textContent='Önce erişim tokenını gir.';return}const el=document.getElementById('checkResult');el.textContent='API bağlantıları kontrol ediliyor...';try{const r=await fetch('/bist/connections',{headers:{Authorization:'Bearer '+token}});const j=await r.json();el.textContent='HTTP '+r.status+'\\n'+JSON.stringify(j,null,2)}catch(e){el.textContent='Bağlantı sorunu: '+e.message}});for(const [id,mode] of [['plain','plain'],['ground','grounding']])document.getElementById(id).addEventListener('click',async()=>{const token=document.getElementById('token').value,el=document.getElementById('testResult');if(!token){el.textContent='Önce erişim tokenını gir.';return}el.textContent='Test ediliyor...';try{const r=await fetch('/bist/gemini-test?mode='+mode,{headers:{Authorization:'Bearer '+token}}),j=await r.json();el.textContent='HTTP '+r.status+'\\n'+JSON.stringify(j,null,2)}catch(e){el.textContent='Test hatası: '+e.message}});go.addEventListener('click',async()=>{const token=document.getElementById('token').value, symbol=document.getElementById('symbol').value.trim().toUpperCase();if(!token){out.textContent='Erişim tokenı gerekli.';return}if(!/^[A-Z0-9]{3,6}$/.test(symbol)){out.textContent='Geçersiz hisse kodu.';return}go.disabled=true;out.textContent='Araştırılıyor...';try{const r=await fetch('/bist/research',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({symbol})});const data=await r.json();out.textContent='HTTP '+r.status+'\n'+JSON.stringify(data,null,2)}catch(e){out.textContent='Bağlantı sorunu: '+e.message}finally{go.disabled=false}});</script></html>`;
 if((u.pathname==="/"||u.pathname==="/bist")&&request.method==="GET")return new Response(dashboard,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"}});
 const bearer=request.headers.get("Authorization")||"";
 const provided=bearer.startsWith("Bearer ")?bearer.slice(7):"";
 if(!provided||!env.ACCESS_TOKEN)return reply({error:"Unauthorized"},401);
 const [a,b]=await Promise.all([hash(provided),hash(env.ACCESS_TOKEN)]);
 let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];
 if(diff!==0)return reply({error:"Unauthorized"},401);
 const cors={};
 if(u.pathname==="/bist/gemini-test"&&request.method==="GET"){
   const mode=u.searchParams.get("mode");
   if(mode!=="plain"&&mode!=="grounding")return reply({error:"Invalid test mode"},422);
   const payload={contents:[{parts:[{text:"Reply in Turkish with exactly: BAGLANTI TESTI BASARILI"}]}],generationConfig:{temperature:0,maxOutputTokens:90}};
   if(mode==="grounding")payload.tools=[{google_search:{}}];
   try{
     const r=await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",{method:"POST",headers:{"x-goog-api-key":env.GEMINI_API_KEY||"","Content-Type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});
     if(!r.ok){let e={};try{e=await r.json()}catch{}return reply({mode,provider_http:r.status,status:"FAILED",provider_code:e.error?.status||null,provider_message:String(e.error?.message||"").slice(0,350)},200)}
     const j=await r.json();return reply({mode,provider_http:r.status,status:"SUCCESS",answer:(j.candidates?.[0]?.content?.parts||[]).map(x=>x.text||"").join("").slice(0,500),grounding_chunks:j.candidates?.[0]?.groundingMetadata?.groundingChunks?.length||0},200);
   }catch{return reply({mode,status:"TIMEOUT_OR_NETWORK_ERROR"},200)}
 }
 if(u.pathname==="/bist/connections"&&request.method==="GET"){
   const inspect=async(url,headers)=>{
     try{const r=await fetch(url,{headers,signal:AbortSignal.timeout(9000)});return {http:r.status,connection:r.ok?"CONNECTED":r.status===401||r.status===403?"INVALID_OR_FORBIDDEN":r.status===429?"RATE_LIMITED":"HTTP_ERROR"}}
     catch{return {connection:"NETWORK_ERROR"}}
   };
   const [gemini,openai]=await Promise.all([
     inspect("https://generativelanguage.googleapis.com/v1beta/models",{"x-goog-api-key":env.GEMINI_API_KEY||""}),
     inspect("https://api.openai.com/v1/models",{"Authorization":"Bearer "+(env.OPENAI_API_KEY||"")})
   ]);
   return reply({gemini,openai,notice:"Model listesi erişimi araştırma üretim kotasını veya Search Grounding yetkisini doğrulamaz.",keys_exposed:false},200);
 }

 if(u.pathname==="/bist/status"&&request.method==="GET")
   return reply({service:"BIST AVCI research",ready:!!env.GEMINI_API_KEY,mode:"manual",orders:false,grounding:"search-is-not-KAP-verification"},200,cors);
 if(u.pathname==="/bist/research"&&request.method==="POST"){
   if(!(request.headers.get("Content-Type")||"").includes("application/json"))return reply({error:"JSON gerekli"},415,cors);
   if(Number(request.headers.get("Content-Length")||0)>1024)return reply({error:"Istek buyuk"},413,cors);
   let data;try{data=await request.json()}catch{return reply({error:"JSON gecersiz"},400,cors)}
   const symbol=String(data.symbol||"").trim().toUpperCase();
   if(!/^[A-Z0-9]{3,6}$/.test(symbol))return reply({error:"Sembol gecersiz"},422,cors);
   if(!env.DB||!env.GEMINI_API_KEY)return reply({error:"Servis hazir degil"},503,cors);
   const day=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Istanbul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
   const stamp=new Date().toISOString();
   const db=env.DB;
   // One SQLite write statement claims the symbol and available daily slot together.
   // D1 serializes writes; a same-day UNIQUE(day,symbol) prevents duplicate calls.
   // FAILED reservations do not count against the five daily slots.
   try{
     const previous=await db.prepare("SELECT status,response_json FROM bist_research_cache WHERE day=? AND symbol=?").bind(day,symbol).first();
     if(previous?.status==="DONE"&&previous.response_json)return reply({...JSON.parse(previous.response_json),cached:true},200,cors);
     if(previous?.status==="RESERVED")return reply({symbol,status:"NEWS_REVIEW_PENDING",technical_score_only:true},202,cors);
     const claim=await db.prepare(
       "INSERT INTO bist_research_cache(day,symbol,status,created_at,attempts) "+
       "SELECT ?,?,'RESERVED',?,1 WHERE (SELECT COUNT(*) FROM bist_research_cache WHERE day=? AND status IN ('RESERVED','DONE')) < 20 "+
       "ON CONFLICT(day,symbol) DO UPDATE SET status='RESERVED',response_json=NULL,created_at=excluded.created_at,attempts=bist_research_cache.attempts+1 "+
       "WHERE bist_research_cache.status='FAILED' AND bist_research_cache.attempts<3 AND "+
       "(SELECT COUNT(*) FROM bist_research_cache WHERE day=? AND status IN ('RESERVED','DONE')) < 20"
     ).bind(day,symbol,stamp,day,day).run();
     if(claim.meta?.changes!==1){
       const current=await db.prepare("SELECT status,response_json,attempts FROM bist_research_cache WHERE day=? AND symbol=?").bind(day,symbol).first();
       if(current?.status==="DONE"&&current.response_json)return reply({...JSON.parse(current.response_json),cached:true},200,cors);
       if(current?.status==="RESERVED")return reply({symbol,status:"NEWS_REVIEW_PENDING",technical_score_only:true},202,cors);
       if(current?.status==="FAILED"&&Number(current.attempts)>=3)return reply({symbol,status:"RETRY_LIMIT",attempts:current.attempts,limit:3,day},429,cors);
       return reply({status:"DAILY_LIMIT",limit:20,day},429,cors);
     }
   }catch{return reply({status:"NEWS_REVIEW_PENDING",error:"Rezervasyon basarisiz"},503,cors)}
   const fail=async(reason)=>{
     // Failed claims stop occupying a daily slot; no separate counter to refund.
     try{await db.prepare("UPDATE bist_research_cache SET status='FAILED' WHERE day=? AND symbol=? AND status='RESERVED'").bind(day,symbol).run()}catch{}
     return reply({symbol,status:"NEWS_REVIEW_PENDING",technical_score_only:true,reason},202,cors);
   };
   try{
     const prompt="Turkce yaz. BIST sembolu "+symbol+" icin guncel sirket haberlerini ara. Google sonucu resmi KAP bildirimi degildir. Resmi KAP bildirim kimligi ve tarihi yoksa resmi teyit yapildigini iddia etme. Eski veya farkli sirket haberini yeni haber diye sunma. Kaynak yoksa DOGRULANAMADI yaz. Yatirim tavsiyesi ve emir verme. En fazla 1200 karakter.";
     const url="https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent";
     const r=await fetch(url,{method:"POST",headers:{"x-goog-api-key":env.GEMINI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt}]}],tools:[{google_search:{}}],generationConfig:{temperature:0.2,maxOutputTokens:600}}),signal:AbortSignal.timeout(15000)});
     if(!r.ok){let detail="";try{const err=await r.json();detail=String(err.error?.message||err.error?.status||"").slice(0,180)}catch{}return await fail("GEMINI_HTTP_"+r.status+(detail?": "+detail:""));}
     const j=await r.json(),candidate=j.candidates?.[0]||{};
     const answer=(candidate.content?.parts||[]).map(p=>p.text||"").join("").slice(0,4000);
     const citations=(candidate.groundingMetadata?.groundingChunks||[]).filter(x=>x.web?.uri).slice(0,8).map(x=>({title:x.web.title||"",url:x.web.uri}));
     const result={symbol,status:citations.length?"SEARCH_RESULT_UNVERIFIED":"NEWS_REVIEW_PENDING",answer,citations,officialKapVerified:false,technical_score_only:!citations.length,orders:false};
     await db.prepare("UPDATE bist_research_cache SET status='DONE',response_json=? WHERE day=? AND symbol=? AND status='RESERVED'").bind(JSON.stringify(result),day,symbol).run();
     return reply(result,200,cors);
   }catch{return await fail("TIMEOUT_OR_PROVIDER_ERROR")}
 }

 return reply({error:"Not found"},404);
}};
