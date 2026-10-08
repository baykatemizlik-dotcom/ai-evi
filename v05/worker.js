// AI Evi v0.5 prototype: separate development branch, NOT the production entrypoint.
// D1 binding DB is mandatory. No DB = no paid calls. No automatic paid Gemini fallback.
const fields={GPT_DRAFT:"gpt_draft",GEMINI_REVIEW:"gemini_review",GPT_REVISION:"gpt_revision",GEMINI_FINAL:"gemini_final"};
const next={GPT_DRAFT:"GEMINI_REVIEW",GEMINI_REVIEW:"GPT_REVISION",GPT_REVISION:"GEMINI_FINAL",GEMINI_FINAL:"DONE"};
const json=(v,status=200,h={})=>new Response(JSON.stringify(v),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...h}});
function history(row){return{ id:row.id,stage:row.stage,status:row.status,question:row.question,gptDraft:row.gpt_draft,geminiReview:row.gemini_review,gptRevision:row.gpt_revision,geminiFinal:row.gemini_final,result:row.result,error:row.last_error,updatedAt:row.updated_at};}
const now=()=>new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",dateStyle:"full",timeStyle:"short"}).format(new Date());
function critical(question){return /(emir ver|alım yap|satış yap|stop.loss|trailing.stop|iade yap|fiyat değiştir|canlıya al|deploy|para transfer)/i.test(question);}
async function openai(env,row,revision){
 const prior=revision?"İlk taslak: "+row.gpt_draft+"\nGemini eleştirisi: "+row.gemini_review+"\nEleştiriyi değerlendirip düzeltilmiş çözüm üret.":"";
 const prompt="AI Evi Berker'in OpenAI ve Gemini ortak yazılım çalışma platformudur. Şu an Türkiye tarihi "+now()+". Türkçe ve somut cevap ver. Yapmadığın doğrulamayı yapmış gibi gösterme. "+prior+"\nGörev: "+row.question;
 const r=await fetch("https://api.openai.com/v1/chat/completions",{method:"POST",headers:{Authorization:"Bearer "+env.OPENAI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({model:env.OPENAI_MODEL,max_completion_tokens:900,messages:[{role:"user",content:prompt}]}),signal:AbortSignal.timeout(23000)});
 if(!r.ok)throw Object.assign(new Error("OpenAI HTTP "+r.status),{code:r.status});
 const j=await r.json();const t=j.choices?.[0]?.message?.content?.trim();if(!t)throw new Error("OpenAI boş yanıt");return t;
}
async function gemini(env,row,final){
 const prior=final?"İlk GPT taslağı: "+row.gpt_draft+"\nSenin ilk incelemen: "+row.gemini_review+"\nGPT'nin revizyonu: "+row.gpt_revision:"GPT taslağı: "+row.gpt_draft;
 const prompt="AI Evi: Berker'in iki modelin eleştirel şekilde çalıştığı yazılım platformu. Türkiye tarihi "+now()+".\nGörev: "+row.question+"\n"+prior+"\nSadece geçerli JSON döndür: {\"review\":\"eleştiri\",\"result\":\"ortak sonuç veya itiraz\",\"agree\":true}. Anlaşmazlık varsa agree=false. Kritik eylemler Berker onayı ister.";
 const r=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent(env.GEMINI_MODEL)+":generateContent",{method:"POST",headers:{"x-goog-api-key":env.GEMINI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{maxOutputTokens:1300,responseMimeType:"application/json"}}),signal:AbortSignal.timeout(23000)});
 if(!r.ok)throw Object.assign(new Error("Gemini HTTP "+r.status),{code:r.status});
 const j=await r.json();const raw=(j.candidates?.[0]?.content?.parts||[]).map(p=>p.text||"").join("");const parsed=JSON.parse(raw);
 if(typeof parsed.review!=="string"||typeof parsed.result!=="string"||typeof parsed.agree!=="boolean")throw new Error("Gemini JSON formatı eksik");
 return parsed;
}
export default {async fetch(req,env){
 const url=new URL(req.url),origin=req.headers.get("Origin")||"";
 const expected="https://baykatemizlik-dotcom.github.io";
 const cors={"Access-Control-Allow-Origin":origin===expected?origin:"null","Access-Control-Allow-Headers":"Content-Type,Authorization","Access-Control-Allow-Methods":"POST,GET,OPTIONS","Vary":"Origin"};
 if(origin!==expected)return json({error:"Origin reddedildi"},403,cors);
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
 if(!env.DB||!env.ACCESS_TOKEN||!env.OPENAI_MODEL||!env.GEMINI_MODEL||!env.OPENAI_API_KEY||!env.GEMINI_API_KEY)return json({error:"Eksik DB, ENV veya Secrets. Harcama kapalı."},503,cors);
 const supplied=req.headers.get("Authorization")||"";
 const enc=new TextEncoder(),digest=async s=>new Uint8Array(await crypto.subtle.digest("SHA-256",enc.encode(s)));
 const [a,b]=await Promise.all([digest(supplied),digest("Bearer "+env.ACCESS_TOKEN)]);let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];
 if(diff!==0||supplied==="Bearer ")return json({error:"Yetkisiz"},401,cors);
 try {
 if(url.pathname==="/v05/start"&&req.method==="POST"){
  const body=await req.json(),question=String(body.question||"").trim();
  if(question.length<5||question.length>2000)return json({error:"Soru 5-2000 karakter olmalı"},400,cors);
  // One client-generated UUID is the conversation id: repeat requests never create a duplicate.
  const id=String(body.id||"");
  if(!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(id))return json({error:"Geçerli UUID gerekli"},400,cors);
  await env.DB.prepare("INSERT OR IGNORE INTO conversations(id,question) VALUES(?,?)").bind(id,question).run();
  const row=await env.DB.prepare("SELECT * FROM conversations WHERE id=?").bind(id).first();
  if(row.question!==question)return json({error:"Aynı id farklı soruda kullanılamaz"},409,cors);
  return json(history(row),200,cors);
 }
 if(url.pathname==="/v05/status"&&req.method==="GET"){
  const id=url.searchParams.get("id")||"";const row=await env.DB.prepare("SELECT * FROM conversations WHERE id=?").bind(id).first();
  return row?json(history(row),200,cors):json({error:"Kayıt bulunamadı"},404,cors);
 }
 if(url.pathname==="/v05/decisions"&&req.method==="GET"){
  const project=String(url.searchParams.get("project")||"genel").slice(0,60);
  const items=await env.DB.prepare("SELECT id,project,title,body,status,created_at FROM decisions WHERE project=? AND status='active' ORDER BY updated_at DESC LIMIT 50").bind(project).all();
  return json({decisions:items.results||[]},200,cors);
 }
 if(url.pathname==="/v05/decisions"&&req.method==="POST"){
  const body=await req.json(),id=String(body.id||""),project=String(body.project||"genel").trim(),title=String(body.title||"").trim(),content=String(body.body||"").trim();
  if(!/^[0-9a-f-]{36}$/i.test(id)||!project||project.length>60||title.length<3||title.length>150||content.length<5||content.length>6000)return json({error:"Karar alanları geçersiz."},400,cors);
  await env.DB.prepare("INSERT OR IGNORE INTO decisions(id,project,title,body) VALUES(?,?,?,?)").bind(id,project,title,content).run();
  return json({saved:true,id},200,cors);
 }
 if(url.pathname!=="/v05/step"||req.method!=="POST")return json({error:"Bulunamadı"},404,cors);
 const body=await req.json(),id=String(body.id||"");
 const row=await env.DB.prepare("SELECT * FROM conversations WHERE id=?").bind(id).first();
 if(!row)return json({error:"Önce start gerekir"},404,cors);
 if(row.status==="DONE"||row.stage==="DONE")return json(history(row),200,cors);
 if(row.status==="WAITING" && row.last_error && /HTTP (429|503)/.test(row.last_error)){
  const elapsed=Date.now()-Date.parse((row.updated_at||"").replace(" ","T")+"Z");
  if(!Number.isFinite(elapsed)||elapsed<60*60*1000)return json({error:"Gemini kota/yük beklemesi: bir saat dolmadan yeniden istek gönderilmeyecek.",...history(row)},429,cors);
 }
 if(!["READY","WAITING"].includes(row.status))return json({error:"Aşama otomatik tekrar çalıştırılamaz; manuel kontrol gerekli.",...history(row)},409,cors);
 const stage=row.stage,isGPT=stage==="GPT_DRAFT"||stage==="GPT_REVISION";
 // Claim before calling ANY external model. A duplicate /step cannot win the claim.
 // Conservative rule: if execution crashes after claim, it remains RUNNING until reviewed.
 const claimed=await env.DB.prepare("UPDATE conversations SET status='RUNNING',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND stage=? AND status IN ('READY','WAITING') RETURNING id").bind(id,stage).first();
 if(!claimed)return json({error:"Aşama zaten yürütülüyor.",...history(row)},409,cors);
 try{
  const value=isGPT?await openai(env,row,stage==="GPT_REVISION"):await gemini(env,row,stage==="GEMINI_FINAL");
  const text=isGPT?value:JSON.stringify(value);
  // ECONOMY MODE: Agreement at first review finishes the conversation early.
  // This avoids the second GPT and second Gemini requests altogether.
  const earlyAgreement=stage==="GEMINI_REVIEW" && value.agree===true;
  const destination=earlyAgreement?"DONE":next[stage],done=destination==="DONE";
  const result=done?(critical(row.question)?"BERKER ONAYI GEREKLİ\\n":"")+String(value.result||""):null;
  const field=fields[stage];if(!field)throw new Error("Bilinmeyen aşama");
  await env.DB.batch([
   env.DB.prepare("UPDATE conversations SET "+field+"=?,stage=?,status=?,result=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='RUNNING' AND stage=?").bind(text,destination,done?"DONE":"READY",result,id,stage),
   env.DB.prepare("INSERT OR IGNORE INTO conversation_events(id,conversation_id,stage,content) VALUES(?,?,?,?)").bind(id+":"+stage,id,stage,text)
  ]);
 }catch(e){
  // Keep the same stage. A retry of an uncertain OpenAI request is blocked to avoid duplicate billing.
  const status=isGPT?"NEEDS_MANUAL_REVIEW":"WAITING";
  await env.DB.prepare("UPDATE conversations SET status=?,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND stage=?").bind(status,String(e.message||e).slice(0,200),id,stage).run();
 }
 const fresh=await env.DB.prepare("SELECT * FROM conversations WHERE id=?").bind(id).first();return json(history(fresh),200,cors);
 }catch(e){return json({error:"Beklenmeyen işlem hatası: "+String(e.message||e).slice(0,120)},500,cors)}
}};