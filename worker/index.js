import v05 from "../v05/worker.js";
// AI Evi v0.4 - single-user Cloudflare Worker
const reply=(data,status=200,cors={})=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...cors}});
const policy="Türkçe yanıt ver. Gerçek dış doğrulama veya otomatik finansal, otel, yazılım dağıtım eylemi yapma.";
const critical=/(\bal\b|\bsat\b|emir|trailing.stop|stop.loss|iade|fiyat değiştir|deploy|canlıya al|havale|para transfer)/i;
export default {async fetch(request,env){
 const u=new URL(request.url),origin=request.headers.get("Origin")||"";
 // GitHub Pages ana alan adı, path veya sondaki / ile kaydedilmiş olsa da doğru origin'e indirgenir.
 let configured="";try{configured=new URL((env.ALLOWED_ORIGIN||"").trim()).origin}catch{}
 const allowed=new Set([configured,"https://baykatemizlik-dotcom.github.io"].filter(Boolean));
 const permitted=allowed.has(origin)||(!origin&&u.pathname.startsWith("/bist/"));
 const cors={"Access-Control-Allow-Origin":permitted?origin:"null","Vary":"Origin","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type,Authorization","Access-Control-Max-Age":"600"};
 if(!permitted)return reply({error:"İzin verilmeyen site.",hint:"AI Evi'ni https://baykatemizlik-dotcom.github.io/ai-evi/ üzerinden açın."},403,cors);
 if(request.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
 const missing=["ACCESS_TOKEN","OPENAI_API_KEY","GEMINI_API_KEY","OPENAI_MODEL","GEMINI_MODEL"].filter(k=>!env[k]);
 if(missing.length)return reply({error:"Worker Secrets ve model ENV ayarları eksik.",missing},503,cors);
 const bearer=request.headers.get("Authorization")||"";
 const provided=bearer.startsWith("Bearer ")?bearer.slice(7):"";
 const hash=async s=>new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s)));
 const [a,b]=await Promise.all([hash(provided),hash(env.ACCESS_TOKEN)]);let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];
 if(!provided||diff!==0)return reply({error:"Yetkisiz erişim."},401,cors);

 // BIST AVCI v0.1 API: same existing Worker secrets, manual calls only.
 if(u.pathname==="/bist/status"&&request.method==="GET")
   return reply({service:"BIST AVCI research",ready:!!env.GEMINI_API_KEY,mode:"manual",orders:false,grounding:"search-is-not-KAP-verification"},200,cors);
 if(u.pathname==="/bist/research"&&request.method==="POST"){
   if(!(request.headers.get("Content-Type")||"").includes("application/json"))
     return reply({error:"JSON gerekli"},415,cors);
   if(Number(request.headers.get("Content-Length")||0)>3000)return reply({error:"Istek cok buyuk"},413,cors);
   let data;try{data=await request.json()}catch{return reply({error:"JSON gecersiz"},400,cors)}
   const symbol=String(data.symbol||"").trim().toUpperCase();
   if(!/^[A-Z0-9]{3,7}$/.test(symbol))return reply({error:"BIST sembolu gecersiz"},422,cors);
   if(!env.DB)return reply({error:"Kota veritabani yok; arastirma kapali"},503,cors);
   try{
     await env.DB.prepare("CREATE TABLE IF NOT EXISTS bist_ai_queries (day TEXT NOT NULL, symbol TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(day,symbol))").run();
     const day=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Istanbul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
     const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM bist_ai_queries WHERE day=?").bind(day).first();
     const prior=await env.DB.prepare("SELECT 1 AS found FROM bist_ai_queries WHERE day=? AND symbol=?").bind(day,symbol).first();
     if(prior)return reply({status:"ALREADY_REQUESTED",symbol,day,note:"Tekrar sorgu engellendi; onceki sonucu tekrar kullanin"},409,cors);
     if(Number(count?.n||0)>=5)return reply({status:"DAILY_LIMIT",limit:5,day},429,cors);
     await env.DB.prepare("INSERT INTO bist_ai_queries (day,symbol,created_at) VALUES (?,?,?)").bind(day,symbol,new Date().toISOString()).run();
     const prompt="Turkce yanit ver. BIST sirket sembolu "+symbol+" icin son 24 saatteki finans haberleri ve KAP aciklamalarini ara. Yalniz tarihle ve kaynagiyla desteklenen iddialari belirt. Google Search sonucu tek basina resmi KAP dogrulamasi DEGILDIR. Resmi KAP kaynak URL ve bildirim kimligi olmadan KAP teyit edildi deme. Yatirim tavsiyesi, fiyat tahmini ve emir verme. Kaynak yoksa DOGRULANAMADI de. 1200 karakteri asma.";
     const url="https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
     const r=await fetch(url,{method:"POST",headers:{"x-goog-api-key":env.GEMINI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt}]}],tools:[{google_search:{}}],generationConfig:{temperature:0.2,maxOutputTokens:600}}),signal:AbortSignal.timeout(20000)});
     if(!r.ok)return reply({status:"NEWS_REVIEW_PENDING",symbol,providerStatus:r.status},202,cors);
     const result=await r.json();
     const candidate=result.candidates?.[0]||{};
     const answer=(candidate.content?.parts||[]).map(p=>p.text||"").join("").slice(0,4000);
     const citations=(candidate.groundingMetadata?.groundingChunks||[]).filter(x=>x.web?.uri).slice(0,8).map(x=>({title:x.web.title||"",url:x.web.uri}));
     return reply({symbol,status:citations.length?"SEARCH_RESULT_UNVERIFIED":"NEWS_REVIEW_PENDING",answer,citations,officialKapVerified:false,orders:false},200,cors);
   }catch(e){return reply({status:"NEWS_REVIEW_PENDING",symbol,error:"Arastirma tamamlanamadi"},503,cors)}
 }
 if(u.pathname.startsWith("/v05/"))return v05.fetch(request,env);
 if(u.pathname==="/test"&&request.method==="GET"){
   const check=async(url,headers)=>{try{const r=await fetch(url,{headers,signal:AbortSignal.timeout(9000)});return r.ok?"Aktif":r.status===429?"Kota sınırı":"HTTP "+r.status}catch{return "Bağlantı hatası"}};
   const [openai,gemini]=await Promise.all([check("https://api.openai.com/v1/models",{Authorization:"Bearer "+env.OPENAI_API_KEY}),check("https://generativelanguage.googleapis.com/v1beta/models",{"x-goog-api-key":env.GEMINI_API_KEY})]);
   return reply({ok:openai==="Aktif"&&gemini==="Aktif",openai,gemini,models:{openai:env.OPENAI_MODEL,gemini:env.GEMINI_MODEL},note:"Seçili modele erişim, kredi bakiyesi veya ücretsiz kota bu testle doğrulanmaz."},200,cors);
 }
 const reviewOnly=u.pathname==="/api/review-only";
 if(!reviewOnly&&u.pathname!=="/api/orchestrate"||request.method!=="POST")return reply({error:"Bulunamadı."},404,cors);
 if(!(request.headers.get("Content-Type")||"").includes("application/json"))return reply({error:"JSON gerekli."},415,cors);
 if(Number(request.headers.get("Content-Length")||0)>12000)return reply({error:"İstek çok büyük."},413,cors);
 let body;try{body=await request.json()}catch{return reply({error:"Geçersiz JSON."},400,cors)}
 const question=typeof body.question==="string"?body.question.trim():"";
 const nowTR=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",weekday:"long",year:"numeric",month:"long",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date());
 const context="Güncel tarih/saat (Türkiye, Europe/Istanbul): "+nowTR+". AI Evi, Berker için ChatGPT ile Gemini\u0027nin ortak çalıştığı yazılım platformudur; eğitim/ajans şirketi değildir. Bu tarihi temel al; doğrulamadığın bilgiyi kesinmiş gibi söyleme.";
 if(question.length<5||question.length>4000)return reply({error:"Soru 5-4000 karakter olmalı."},400,cors);
 let openai;
 if(reviewOnly){openai=typeof body.openai==="string"?body.openai.trim():"";if(openai.length<5||openai.length>6000)return reply({error:"Yeniden inceleme için önceki OpenAI yanıtı gerekli."},400,cors)}else try {
 const r=await fetch("https://api.openai.com/v1/chat/completions",{method:"POST",headers:{"Authorization":"Bearer "+env.OPENAI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({model:env.OPENAI_MODEL,max_completion_tokens:1200,messages:[{role:"system",content:policy+" "+context},{role:"user",content:question}]}),signal:AbortSignal.timeout(24000)});
 if(!r.ok)return reply({error:"OpenAI HTTP "+r.status+"; model erişimini kontrol et."},r.status===429?429:502,cors);
 const j=await r.json();openai=j.choices?.[0]?.message?.content?.trim();if(!openai)throw Error("OpenAI boş yanıt");
 }catch(e){return reply({error:"OpenAI bağlantı hatası: "+String(e.message||e).slice(0,100)},502,cors)}
 try {
 const instruction=context+'\n\nGörev: '+question+'\n\nOpenAI görüşü: '+openai+'\n\nBu görüşü bağımsız denetle. Yalnız geçerli JSON döndür: {"review":"inceleme","result":"sonuç","agree":true}. İtiraz varsa agree=false. Gerçekte yapmadığın kaynak doğrulamasını iddia etme. Türkçe yaz. Kritik eylemler kullanıcı onayı ister.';
 const url="https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent(env.GEMINI_MODEL)+":generateContent";
 const payload=JSON.stringify({contents:[{role:"user",parts:[{text:instruction}]}],generationConfig:{maxOutputTokens:1700,responseMimeType:"application/json",thinkingConfig:{thinkingLevel:"low"}}});
 let r, detail="";
 for(let attempt=0;attempt<3;attempt++){
   r=await fetch(url,{method:"POST",headers:{"x-goog-api-key":env.GEMINI_API_KEY,"Content-Type":"application/json"},body:payload,signal:AbortSignal.timeout(22000)});
   if(r.ok)break;
   const transient=[429,500,502,503,504].includes(r.status);
   if(!transient||attempt===2){
     try{const e=await r.json();detail=String(e.error?.message||"").slice(0,180)}catch{}
     break;
   }
   await new Promise(resolve=>setTimeout(resolve,800*Math.pow(2,attempt)+Math.floor(Math.random()*450)));
 }
 if(!r.ok)return reply({openai,gemini:"İnceleme bekleniyor",result:"Ortak sonuç yok.",status:"PENDING_GEMINI_REVIEW",error:"Gemini HTTP "+r.status+(detail?": "+detail:"")+"; yalnız Gemini yeniden denenebilir."},[429,503].includes(r.status)?r.status:502,cors);
 const j=await r.json(),raw=(j.candidates?.[0]?.content?.parts||[]).map(p=>p.text||"").join("\n");
 const parsed=JSON.parse(raw),gemini=String(parsed.review||"İnceleme özeti yok"),agreed=parsed.agree===true&&!!parsed.result;
 const status=critical.test(question)?"NEEDS_BERKER":agreed?"REVIEWED":"DISAGREE";
 return reply({openai,gemini,result:String(parsed.result||"Uzlaşılmış sonuç yok."),status,models:{openai:env.OPENAI_MODEL,gemini:env.GEMINI_MODEL}},200,cors);
 }catch(e){return reply({openai,gemini:"İnceleme tamamlanamadı.",result:"Berker değerlendirmesi gerekiyor.",status:"PENDING_GEMINI_REVIEW",error:"Gemini bağlantı/JSON hatası; yalnız Gemini yeniden denenebilir."},502,cors)}
}};