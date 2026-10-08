// AI Evi v0.4 - single-user Cloudflare Worker
const reply=(data,status=200,cors={})=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...cors}});
const policy="Türkçe yanıt ver. Gerçek dış doğrulama veya otomatik finansal, otel, yazılım dağıtım eylemi yapma.";
const critical=/(\bal\b|\bsat\b|emir|trailing.stop|stop.loss|iade|fiyat değiştir|deploy|canlıya al|havale|para transfer)/i;
export default {async fetch(request,env){
 const u=new URL(request.url),origin=request.headers.get("Origin")||"";
 // GitHub Pages ana alan adı, path veya sondaki / ile kaydedilmiş olsa da doğru origin'e indirgenir.
 let configured="";try{configured=new URL((env.ALLOWED_ORIGIN||"").trim()).origin}catch{}
 const allowed=new Set([configured,"https://baykatemizlik-dotcom.github.io"].filter(Boolean));
 const permitted=allowed.has(origin);
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
 if(question.length<5||question.length>4000)return reply({error:"Soru 5-4000 karakter olmalı."},400,cors);
 let openai;
 if(reviewOnly){openai=typeof body.openai==="string"?body.openai.trim():"";if(openai.length<5||openai.length>6000)return reply({error:"Yeniden inceleme için önceki OpenAI yanıtı gerekli."},400,cors)}else try {
 const r=await fetch("https://api.openai.com/v1/chat/completions",{method:"POST",headers:{"Authorization":"Bearer "+env.OPENAI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({model:env.OPENAI_MODEL,max_completion_tokens:1200,messages:[{role:"system",content:policy},{role:"user",content:question}]}),signal:AbortSignal.timeout(24000)});
 if(!r.ok)return reply({error:"OpenAI HTTP "+r.status+"; model erişimini kontrol et."},r.status===429?429:502,cors);
 const j=await r.json();openai=j.choices?.[0]?.message?.content?.trim();if(!openai)throw Error("OpenAI boş yanıt");
 }catch(e){return reply({error:"OpenAI bağlantı hatası: "+String(e.message||e).slice(0,100)},502,cors)}
 try {
 const instruction='Görev: '+question+'\n\nOpenAI görüşü: '+openai+'\n\nBu görüşü bağımsız denetle. Yalnız geçerli JSON döndür: {"review":"inceleme","result":"sonuç","agree":true}. İtiraz varsa agree=false. Gerçekte yapmadığın kaynak doğrulamasını iddia etme. Türkçe yaz. Kritik eylemler kullanıcı onayı ister.';
 const r=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent(env.GEMINI_MODEL)+":generateContent",{method:"POST",headers:{"x-goog-api-key":env.GEMINI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({contents:[{role:"user",parts:[{text:instruction}]}],generationConfig:{maxOutputTokens:1700,responseMimeType:"application/json"}}),signal:AbortSignal.timeout(24000)});
 if(!r.ok)return reply({openai,gemini:"İnceleme bekleniyor",result:"Ortak sonuç yok.",status:"PENDING_GEMINI_REVIEW",error:"Gemini HTTP "+r.status+"; yalnız Gemini yeniden denenebilir."},r.status===429?429:502,cors);
 const j=await r.json(),raw=(j.candidates?.[0]?.content?.parts||[]).map(p=>p.text||"").join("\n");
 const parsed=JSON.parse(raw),gemini=String(parsed.review||"İnceleme özeti yok"),agreed=parsed.agree===true&&!!parsed.result;
 const status=critical.test(question)?"NEEDS_BERKER":agreed?"REVIEWED":"DISAGREE";
 return reply({openai,gemini,result:String(parsed.result||"Uzlaşılmış sonuç yok."),status,models:{openai:env.OPENAI_MODEL,gemini:env.GEMINI_MODEL}},200,cors);
 }catch(e){return reply({openai,gemini:"İnceleme tamamlanamadı.",result:"Berker değerlendirmesi gerekiyor.",status:"PENDING_GEMINI_REVIEW",error:"Gemini bağlantı/JSON hatası; yalnız Gemini yeniden denenebilir."},502,cors)}
}};