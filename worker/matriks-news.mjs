import {NEWS_COMPANIES} from './news-catalog.mjs';
import {sha256,saveRaw,boundedText} from './news.mjs';
const iso=n=>new Date(n).toISOString().replace(/\.\d{3}Z$/,'Z');
const reply=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export function normalizeMatriks(x,now=Date.now()){
 if(!x||!['NEWS','FORMATION','DETECTOR','TREND'].includes(x.kind)||typeof x.source_record_id!=='string'||!x.source_record_id||x.source_record_id.length>160||typeof x.headline!=='string'||!x.headline.trim()||x.headline.length>2000||typeof x.published_at!=='string'||!/Z$|[+-]\d\d:\d\d$/.test(x.published_at))throw Error('INVALID_MATRIKS_RECORD');
 const time=Date.parse(x.published_at);if(!Number.isFinite(time)||time>now+60000||time<Date.parse('2000-01-01T00:00:00Z'))throw Error('INVALID_MATRIKS_TIME');
 if(x.body!==undefined&&(typeof x.body!=='string'||x.body.length>14000))throw Error('INVALID_MATRIKS_BODY');
 const related=Array.isArray(x.related_symbols)?x.related_symbols:[];
 if(related.length>100||related.some(s=>typeof s!=='string'||s.length>30))throw Error('INVALID_MATRIKS_SYMBOLS');
 const symbol=typeof x.symbol==='string'?x.symbol:'';
 if(x.kind!=='NEWS'&&!NEWS_COMPANIES[symbol])throw Error('UNKNOWN_EVENT_SYMBOL');
 const base={kind:x.kind,source_record_id:x.source_record_id,headline:x.headline.trim(),published_at:iso(time),related_symbols:related.filter(s=>NEWS_COMPANIES[s]),unmapped_symbols:related.filter(s=>!NEWS_COMPANIES[s]),symbol,body:x.body||'',provider_sources:Array.isArray(x.provider_sources)?x.provider_sources.filter(s=>typeof s==='string').slice(0,20).map(s=>s.slice(0,120)):[],event_data:x.event_data&&typeof x.event_data==='object'?x.event_data:null};
 if(JSON.stringify(base.event_data).length>30000)throw Error('EVENT_TOO_LARGE');return base;
}
export async function matriksRoute(request,env){
 const path=new URL(request.url).pathname;
 if(path==='/bist/news/matriks/ingest'&&request.method==='POST'){
  const input=JSON.parse(await boundedText(new Response(request.body),500000));
  if(!Array.isArray(input.records)||!input.records.length||input.records.length>20)return reply({error:'INVALID_BATCH'},422);
  let records;try{records=input.records.map(x=>normalizeMatriks(x));}catch(e){return reply({error:e.message},422);}
  const accepted=[];for(const x of records){if(x.kind==='NEWS'){
   const raw={...x,source_id:'MATRIKS_NEWS',source_url:'urn:matriks:news:'+encodeURIComponent(x.source_record_id),body_truncated:false,coverage:'LIVE_WHILE_PC_ON',headline_only:!x.body};
   await saveRaw(env.DB,raw,Date.now());
  }else{const hash=await sha256(JSON.stringify(x)),id=await sha256('MATRIKS_EVENT\n'+hash);await env.DB.prepare('INSERT OR IGNORE INTO news_event_records(record_id,content_hash,source_record_id,event_type,symbol,headline,published_at,fetched_at,raw_json) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,hash,x.source_record_id,x.kind,x.symbol,x.headline,x.published_at,iso(Date.now()),JSON.stringify(x)).run();}
  accepted.push({source_record_id:x.source_record_id,kind:x.kind});}
  await env.DB.prepare("INSERT INTO news_sources(source_id,source_url,status,last_attempt_at,last_success_at) VALUES('MATRIKS_PC','urn:matriks:pc','LIVE_WHILE_PC_ON',?,?) ON CONFLICT(source_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,status=excluded.status,error=NULL").bind(iso(Date.now()),iso(Date.now())).run();
  return reply({accepted,coverage:'LIVE_WHILE_PC_ON',kap_full_coverage:false,trend_capture_verified:false});
 }
 if(path==='/bist/news/matriks/status'&&request.method==='GET'){
  const news=await env.DB.prepare("SELECT count(*) count FROM news_records WHERE source_id='MATRIKS_NEWS'").first(),events=await env.DB.prepare('SELECT event_type,count(*) count FROM news_event_records GROUP BY event_type').all(),source=await env.DB.prepare("SELECT last_success_at FROM news_sources WHERE source_id='MATRIKS_PC'").first();return reply({news:news.count,events:events.results,last_received_at:source?.last_success_at||null,coverage:'LIVE_WHILE_PC_ON',pc_delivery_verified:!!source,trend_capture_verified:false});
 }
 if(path==='/bist/news/matriks/events'&&request.method==='GET'){
  const rows=await env.DB.prepare('SELECT record_id,event_type,symbol,headline,published_at,state FROM news_event_records ORDER BY published_at DESC,record_id LIMIT 50').all();return reply({events:rows.results,limit:50,order_signals:false});
 }
 return reply({error:'METHOD_NOT_ALLOWED'},405);
}
