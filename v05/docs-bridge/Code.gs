/**
 * AI Evi Docs Bridge - DRAFT ONLY, NOT DEPLOYED.
 * Web app deployment: execute as owner; access "Anyone" only if strictly necessary.
 * This code requires a backend-only shared token in Apps Script Properties named BRIDGE_TOKEN.
 * It MUST NOT be called directly by a public browser, and token MUST NOT be in Github.
 * Worker must call it server-to-server; Gemini's read-only Workspace cannot invoke it itself.
 */
const DOC_ID="1aM9NXmuAnry98lxKKDJFBcxXqefyWw3NrAfnuhoM5YU";
const MAX=5500;
function doPost(e){
  // Apps Script web apps cannot reliably authenticate Authorization headers.
  // Google Apps Script web request API provides e.postData contents; this prototype
  // validates a shared secret supplied in the JSON body. Requires HTTPS.
  let p;
  try{p=JSON.parse(e.postData.contents)}catch(_){return output({ok:false,error:"invalid_json"})}
  const secret=PropertiesService.getScriptProperties().getProperty("BRIDGE_TOKEN");
  if(!secret||secret.length<32||!p||typeof p.token!=="string"||p.token!==secret)return output({ok:false,error:"not_authorized"});
  const message=String(p.message||"").trim(),kind=String(p.kind||"");
  if(!["review","decision"].includes(kind)||message.length<10||message.length>MAX)return output({ok:false,error:"invalid_payload"});
  const key=String(p.id||"");
  if(!/^[0-9a-f-]{36}$/i.test(key))return output({ok:false,error:"invalid_id"});
  const lock=LockService.getScriptLock();if(!lock.tryLock(5000))return output({ok:false,error:"busy"});
  try{
    const props=PropertiesService.getScriptProperties(),cached=props.getProperty("last_"+key);
    if(cached)return output({ok:true,duplicate:true});
    const doc=DocumentApp.openById(DOC_ID);
    doc.getBody().appendParagraph("[AI_EVI_BRIDGE]["+kind+"]["+key+"] "+message);
    doc.saveAndClose();
    // Dedup record only stored after success; crashes can cause duplicate append.
    props.setProperty("last_"+key,new Date().toISOString());
    return output({ok:true});
  }catch(_){return output({ok:false,error:"write_failed"})}
  finally{lock.releaseLock()}
}
function output(value){return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON)}
