// BIST AVCI research-only Cloudflare Worker. No AI Evi routes.
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
const hash=async s=>new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s)));
export default {async fetch(request,env){
 const u=new URL(request.url);
 const bearer=request.headers.get("Authorization")||"";
 const provided=bearer.startsWith("Bearer ")?bearer.slice(7):"";
 if(!provided||!env.ACCESS_TOKEN)return reply({error:"Unauthorized"},401);
 const [a,b]=await Promise.all([hash(provided),hash(env.ACCESS_TOKEN)]);
 let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];
 if(diff!==0)return reply({error:"Unauthorized"},401);
 const cors={};
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
       "SELECT ?,?,'RESERVED',?,1 WHERE (SELECT COUNT(*) FROM bist_research_cache WHERE day=? AND status IN ('RESERVED','DONE')) < 5 "+
       "ON CONFLICT(day,symbol) DO UPDATE SET status='RESERVED',response_json=NULL,created_at=excluded.created_at,attempts=bist_research_cache.attempts+1 "+
       "WHERE bist_research_cache.status='FAILED' AND bist_research_cache.attempts<3 AND "+
       "(SELECT COUNT(*) FROM bist_research_cache WHERE day=? AND status IN ('RESERVED','DONE')) < 5"
     ).bind(day,symbol,stamp,day,day).run();
     if(claim.meta?.changes!==1){
       const current=await db.prepare("SELECT status,response_json FROM bist_research_cache WHERE day=? AND symbol=?").bind(day,symbol).first();
       if(current?.status==="DONE"&&current.response_json)return reply({...JSON.parse(current.response_json),cached:true},200,cors);
       if(current?.status==="RESERVED")return reply({symbol,status:"NEWS_REVIEW_PENDING",technical_score_only:true},202,cors);
       return reply({status:"DAILY_LIMIT",limit:5,day},429,cors);
     }
   }catch{return reply({status:"NEWS_REVIEW_PENDING",error:"Rezervasyon basarisiz"},503,cors)}
   const fail=async(reason)=>{
     // Failed claims stop occupying a daily slot; no separate counter to refund.
     try{await db.prepare("UPDATE bist_research_cache SET status='FAILED' WHERE day=? AND symbol=? AND status='RESERVED'").bind(day,symbol).run()}catch{}
     return reply({symbol,status:"NEWS_REVIEW_PENDING",technical_score_only:true,reason},202,cors);
   };
   try{
     const prompt="Turkce yaz. BIST sembolu "+symbol+" icin guncel sirket haberlerini ara. Google sonucu resmi KAP bildirimi degildir. Resmi KAP bildirim kimligi ve tarihi yoksa resmi teyit yapildigini iddia etme. Eski veya farkli sirket haberini yeni haber diye sunma. Kaynak yoksa DOGRULANAMADI yaz. Yatirim tavsiyesi ve emir verme. En fazla 1200 karakter.";
     const url="https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
     const r=await fetch(url,{method:"POST",headers:{"x-goog-api-key":env.GEMINI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt}]}],tools:[{google_search:{}}],generationConfig:{temperature:0.2,maxOutputTokens:600}}),signal:AbortSignal.timeout(15000)});
     if(!r.ok)return await fail("GEMINI_HTTP_"+r.status);
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
