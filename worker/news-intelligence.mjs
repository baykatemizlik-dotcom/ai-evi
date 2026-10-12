import {NEWS_COMPANIES} from './news-catalog.mjs';
const iso=n=>new Date(n).toISOString().replace(/\.\d{3}Z$/,'Z');
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const GLOBAL_WORDS=/savaş|savas|jeopolitik|petrol|brent|faiz|enflasyon|merkez bank|fed\b|ecb\b|yaptırım|yaptirim|hürmüz|hurmuz|küresel|kuresel|tarife|ithalat|ihracat|satışları|satışlar|gdp\b|inflation|interest rate|oil\b|war\b/i;
export function newsView(row,now=Date.now()){
 let analysis=null,raw={};try{analysis=row.payload_json?JSON.parse(row.payload_json).analysis:null;raw=row.raw_json?JSON.parse(row.raw_json):{};}catch{}
 let category='GENERAL',basis='NO_MATCH';
 if(analysis?.symbols?.length){category='COMPANY';basis='MODEL_SYMBOLS';}
 else if(raw.related_symbols?.some(s=>NEWS_COMPANIES[s])){category='COMPANY';basis='SOURCE_SYMBOLS';}
 else if(analysis?.sector_keys?.length){category='SECTOR';basis='MODEL_SECTORS';}
 else if(GLOBAL_WORDS.test(row.headline)){category='GLOBAL';basis='HEADLINE_KEYWORDS';}
 const sectors=[...new Set([...(analysis?.sector_keys||[]),...(raw.related_symbols||[]).map(s=>NEWS_COMPANIES[s]?.sector_key).filter(Boolean)])].map(code=>({code,label:Object.values(NEWS_COMPANIES).find(x=>x.sector_key===code)?.sector||code}));
 return {record_id:row.record_id,source_id:row.source_id,source_url:row.source_url,headline:row.headline,published_at:row.published_at,record_version:row.record_version,state:row.state,category,classification_basis:basis,analysis,analysis_location:row.state==='ACKED'?'PC_ARCHIVE':analysis?'CLOUD':'PENDING',related_symbols:raw.related_symbols||[],provider_sources:raw.provider_sources||[],sectors,excerpt:raw.body?.slice(0,800)||'',search_body:raw.body||'',content_scope:!raw.body?'HEADLINE_ONLY':'SOURCE_EXCERPT',review_required:!!analysis&&(analysis.needs_followup||analysis.uncertainty_level==='HIGH'||analysis.importance>=4),age_hours:Math.max(0,(now-Date.parse(row.published_at))/3600000),archived_analysis_unavailable:row.state==='ACKED'&&!analysis};
}
function dateWindow(date){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('INVALID_DATE');const start=Date.parse(date+'T00:00:00+03:00');if(!Number.isFinite(start)||iso(start+3*3600000).slice(0,10)!==date)throw Error('INVALID_DATE');return [iso(start),iso(start+86400000)];
}
async function readWindow(db,start,end,now){
 const rows=await db.prepare('SELECT r.*,b.payload_json,b.raw_json FROM news_records r LEFT JOIN news_bodies b ON b.record_id=r.record_id WHERE r.published_at>=? AND r.published_at<? ORDER BY r.published_at DESC,r.record_id LIMIT 1201').bind(start,end).all();
 const count=await db.prepare('SELECT count(*) total FROM news_records WHERE published_at>=? AND published_at<?').bind(start,end).first();return {total:count.total,scan_truncated:rows.results.length>1200,records:rows.results.slice(0,1200).map(x=>newsView(x,now))};
}
function matches(row,filter){return filter==='ALL'||filter==='RELEVANT'&&row.category!=='GENERAL'||filter==='PENDING'&&row.analysis_location==='PENDING'||filter==='ARCHIVED'&&row.analysis_location==='PC_ARCHIVE'||row.category===filter;}
const fold=s=>String(s||'').toLocaleLowerCase('tr-TR').replace(/ı/g,'i').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
export function searchNews(records,query){
 const terms=key=>fold(query.get(key)).split(/[\s,]+/).filter(Boolean).slice(0,20),any=terms('q'),all=terms('must'),exclude=terms('exclude'),phrase=fold(query.get('phrase'));
 const symbol=(query.get('symbol')||'').trim().toUpperCase(),sector=query.get('sector')||'',source=query.get('source')||'',provider=query.get('provider_source')||'',direction=query.get('direction')||'',min=Number(query.get('importance'))||0,review=query.get('review')==='true',sort=query.get('sort')||'newest';
 if(symbol&&!NEWS_COMPANIES[symbol]||sector&&!Object.values(NEWS_COMPANIES).some(c=>c.sector_key===sector)||direction&&!['POSITIVE','NEGATIVE','MIXED','UNCLEAR'].includes(direction)||!Number.isInteger(min)||min<0||min>5||!['newest','oldest','importance'].includes(sort))throw Error('INVALID_SEARCH_FILTER');
 if(['q','must','exclude','phrase'].some(k=>(query.get(k)||'').length>500))throw Error('SEARCH_TOO_LONG');
 const filtered=records.filter(r=>{
  const a=r.analysis,text=fold([r.headline,r.search_body,a?.summary,...(a?.facts||[]),...(a?.inferences||[])].join(' '));
  if(any.length&&!any.some(t=>text.includes(t))||all.some(t=>!text.includes(t))||exclude.some(t=>text.includes(t))||phrase&&!text.includes(phrase))return false;
  if(symbol&&!(a?.symbols.includes(symbol)||r.related_symbols.includes(symbol)||new RegExp('\\b'+symbol+'\\b').test(r.headline.toUpperCase())))return false;
  if(sector&&!(a?.sector_keys.includes(sector)||a?.symbols.some(s=>NEWS_COMPANIES[s]?.sector_key===sector)||r.related_symbols.some(s=>NEWS_COMPANIES[s]?.sector_key===sector)))return false;
  return (!source||r.source_id===source)&&(!provider||r.provider_sources.includes(provider))&&(!direction||a?.impact_direction===direction)&&(!min||a?.importance>=min)&&(!review||r.review_required);
 });
 return filtered.sort((a,b)=>sort==='importance'?(b.analysis?.importance||0)-(a.analysis?.importance||0)||Date.parse(b.published_at)-Date.parse(a.published_at):sort==='oldest'?Date.parse(a.published_at)-Date.parse(b.published_at):Date.parse(b.published_at)-Date.parse(a.published_at));
}
function publicRecord({search_body,...row}){return row;}
export function makeDigest(records){
 const categories={COMPANY:0,SECTOR:0,GLOBAL:0,GENERAL:0},counts={analyzed:0,pending:0,archived:0,review_required:0};
 for(const r of records){categories[r.category]++;if(r.analysis)counts.analyzed++;else if(r.analysis_location==='PC_ARCHIVE')counts.archived++;else counts.pending++;if(r.review_required)counts.review_required++;}
 const priority=records.filter(x=>x.analysis&&x.category!=='GENERAL').sort((a,b)=>b.analysis.importance-a.analysis.importance||Date.parse(b.published_at)-Date.parse(a.published_at)).slice(0,5);
 return {categories,...counts,priority};
}
export async function intelligenceRoute(request,env,now=Date.now()){
 const u=new URL(request.url),path=u.pathname;
 if(request.method!=='GET')return reply({error:'METHOD_NOT_ALLOWED'},405);
 if(path==='/bist/news/list'||path==='/bist/news/digest'){
  const date=u.searchParams.get('date')||new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Istanbul'}).format(new Date(now));let bounds;try{bounds=dateWindow(date);}catch{return reply({error:'INVALID_DATE'},422);}
  const dateTo=u.searchParams.get('date_to')||date;let to;try{to=dateWindow(dateTo)[1];if(to<=bounds[0]||Date.parse(to)-Date.parse(bounds[0])>31*86400000)throw Error('INVALID_DATE_RANGE');}catch{return reply({error:'INVALID_DATE_RANGE',max_days:31},422);}bounds[1]=to;
  const morning=u.searchParams.get('morning')==='true';if(morning){const cutoff=Date.parse(dateTo+'T09:15:00+03:00');if(Date.parse(bounds[1])-Date.parse(bounds[0])>2*86400000)return reply({error:'MORNING_WINDOW_TOO_LONG'},422);bounds[1]=iso(Math.min(cutoff,now+1000));if(bounds[1]<=bounds[0])return reply({error:'FUTURE_MORNING'},422);}
  const data=await readWindow(env.DB,...bounds,now),digest=makeDigest(data.records),sources=await env.DB.prepare('SELECT source_id,status,last_success_at,error FROM news_sources ORDER BY source_id').all();
  if(path.endsWith('/digest'))return reply({date,date_to:dateTo,time_zone:'Europe/Istanbul',total:data.total,examined:data.records.length,scan_truncated:data.scan_truncated,...digest,priority:digest.priority.map(publicRecord),sources:sources.results,search_options:{sources:[...new Set(data.records.map(x=>x.source_id))],provider_sources:[...new Set(data.records.flatMap(x=>x.provider_sources))],sectors:[...new Map(Object.values(NEWS_COMPANIES).map(c=>[c.sector_key,{code:c.sector_key,label:c.sector}])).values()]},coverage:'PARTIAL',universe_dictionary_count:Object.keys(NEWS_COMPANIES).length,full_company_coverage_verified:false,selection_integration:false});
  const filter=u.searchParams.get('filter')||'ALL';if(!['ALL','RELEVANT','COMPANY','SECTOR','GLOBAL','GENERAL','PENDING','ARCHIVED'].includes(filter))return reply({error:'INVALID_FILTER'},422);
  let filtered;try{filtered=searchNews(data.records.filter(x=>matches(x,filter)),u.searchParams);}catch(e){return reply({error:e.message},422);}const offset=Math.max(0,Math.min(100000,Math.floor(Number(u.searchParams.get('offset'))||0))),limit=50;
  return reply({date,date_to:dateTo,time_zone:'Europe/Istanbul',total:filtered.length,total_collected:data.total,filter,offset,limit,has_more:filtered.length>offset+limit,scan_truncated:data.scan_truncated,coverage:'PARTIAL',records:filtered.slice(offset,offset+limit).map(publicRecord)});
 }
 if(path==='/bist/news/context'){
  const symbol=(u.searchParams.get('symbol')||'').toUpperCase(),company=NEWS_COMPANIES[symbol];if(!company)return reply({error:'UNKNOWN_SYMBOL'},422);
  const hours=Math.max(1,Math.min(168,Number(u.searchParams.get('hours'))||72)),data=await readWindow(env.DB,iso(now-hours*3600000),iso(now+1000),now);
  const brief=r=>({record_id:r.record_id,headline:r.headline,source_url:r.source_url,published_at:r.published_at,age_hours:r.age_hours,verification_status:r.analysis.verification_status,importance:r.analysis.importance,impact_direction:r.analysis.impact_direction,uncertainty_level:r.analysis.uncertainty_level,review_required:r.review_required,facts:r.analysis.facts,inferences:r.analysis.inferences});
  const analyzed=data.records.filter(r=>r.analysis),direct=analyzed.filter(r=>r.analysis.symbols.includes(symbol)),sector=analyzed.filter(r=>!r.analysis.symbols.includes(symbol)&&r.analysis.sector_keys.includes(company.sector_key)),global=analyzed.filter(r=>r.category==='GLOBAL');
  return reply({schema_version:'news-context-v1',symbol,sector_code:company.sector_key,generated_at:iso(now),window_hours:hours,coverage:'PARTIAL',full_company_coverage_verified:false,scan_truncated:data.scan_truncated,pending_records:data.records.filter(r=>r.analysis_location==='PENDING').length,archived_analysis_unavailable:data.records.filter(r=>r.archived_analysis_unavailable).length,direct_events:direct.map(r=>({...brief(r),relation:'DIRECT_COMPANY_REPORT'})),sector_events:sector.map(r=>({...brief(r),relation:'INDIRECT_SECTOR_INFERENCE'})),global_context:global.map(r=>({...brief(r),relation:'GENERAL_CONTEXT_NOT_COMPANY_EFFECT'})),review_required:[...direct,...sector].some(r=>r.review_required),usage_mode:'ADVISORY_ONLY',selection_integration:false,can_generate_order:false});
 }
 return reply({error:'NOT_FOUND'},404);
}
