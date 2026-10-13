import {NEWS_COMPANIES} from './news-catalog.mjs';
const ID='burkut-initial-20261013';
async function readJson(response){
 const reader=response.body?.getReader();if(!reader)throw Error('EMPTY_BODY');let size=0;const chunks=[];
 try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>2000000)throw Error('BODY_TOO_LARGE');chunks.push(r.value);}}catch(e){await reader.cancel();throw e;}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
export function rows(data){if(Array.isArray(data))return data;for(const key of ['data','stocks','items','results','history','prices','content'])if(data&&typeof data==='object'&&data[key]){const r=rows(data[key]);if(r.length)return r;}return [];}
export function summarize(data,now=Date.now()){
 const list=rows(data),symbols=[...new Set(list.map(r=>r.symbol||r.code).filter(s=>typeof s==='string'&&/^[A-Z0-9]{3,6}$/.test(s)))].sort();
 const fields=['symbol','price','currentPrice','changePercent','volume','open','high','low','close','updatedAt','date','timestamp','time'];
 const safe=r=>Object.fromEntries(fields.filter(k=>typeof r?.[k]==='number'&&Number.isFinite(r[k])||typeof r?.[k]==='string'&&(k==='symbol'?/^[A-Z0-9]{3,6}$/.test(r[k]):['updatedAt','date','timestamp','time'].includes(k)&&/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(r[k])&&r[k].length<40)).map(k=>[k,r[k]]));
 const times=list.map(r=>r.updatedAt||r.date||r.timestamp||r.time).map(v=>typeof v==='number'?v<1e12?v*1000:v:typeof v==='string'?Date.parse(v):NaN).filter(Number.isFinite).sort((a,b)=>a-b);
 const expected=Object.keys(NEWS_COMPANIES),present=new Set(symbols),missing=expected.filter(s=>!present.has(s));
 return {record_count:list.length,unique_symbols:symbols.length,expected_symbols:expected.length,matched_symbols:expected.length-missing.length,missing_symbols:missing,newest_timestamp:times.length?new Date(times.at(-1)).toISOString():null,oldest_timestamp:times.length?new Date(times[0]).toISOString():null,newest_age_minutes:times.length?Math.round((now-times.at(-1))/60000):null,samples:list.slice(0,3).map(safe),schema_keys:list[0]?Object.keys(list[0]).slice(0,40):Object.keys(data||{}).slice(0,40),intraday_bars_verified:false};
}
export async function burkutProbe(env,network=fetch){
 if(!env.BURKUT_API_KEY||Date.now()>Date.parse('2026-10-14T00:00:00Z'))return;
 await env.DB.prepare('CREATE TABLE IF NOT EXISTS external_feed_probe(id TEXT PRIMARY KEY,status TEXT NOT NULL,report_json TEXT)').run();
 const claim=await env.DB.prepare("INSERT OR IGNORE INTO external_feed_probe VALUES(?,'RUNNING',NULL)").bind(ID).run();if(!claim.meta.changes)return;
 const report={id:ID,started_at:new Date().toISOString(),key_configured:true,mode:'TEST_ONLY',trading_integration:false,requests:[]};
 try{for(const path of ['/stocks','/stocks/THYAO','/stocks/THYAO/history?days=2']){
  const started=Date.now();try{const response=await network('https://api.burkutportfoy.com/api/public/v1'+path,{headers:{'X-API-Key':env.BURKUT_API_KEY,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(12000)});
   if(!response.ok){await response.body?.cancel();report.requests.push({path,status:response.status,elapsed_ms:Date.now()-started});continue;}
   const data=await readJson(response);report.requests.push({path,status:response.status,elapsed_ms:Date.now()-started,summary:summarize(data),single_stock:path==='/stocks/THYAO'?summarize([data?.data||data]).samples:null});
  }catch{report.requests.push({path,status:'NETWORK_OR_FORMAT_ERROR',elapsed_ms:Date.now()-started});}
 }}finally{report.completed_at=new Date().toISOString();await env.DB.prepare("UPDATE external_feed_probe SET status='COMPLETED',report_json=? WHERE id=?").bind(JSON.stringify(report),ID).run();}
}
