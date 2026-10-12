import {NEWS_COMPANIES} from './news-catalog.mjs';
export const KAP_SOURCE={id:'KAP_PUBLIC',url:'https://www.kap.org.tr/tr/api/disclosure/members/byCriteria',kind:'KAP_PUBLIC',max_age_days:2};
const day=n=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Istanbul'}).format(new Date(n));
export function kapRequest(now){return {method:'POST',redirect:'manual',headers:{'Content-Type':'application/json','Accept-Language':'tr'},body:JSON.stringify({fromDate:day(now-86400000),toDate:day(now),memberType:'IGS',mkkMemberOidList:[],inactiveMkkMemberOidList:[],disclosureClass:'',subjectList:[],isLate:'',mainSector:'',sector:'',subSector:'',marketOid:'',index:'',bdkReview:'',bdkMemberOidList:[],year:'',term:'',ruleType:'',period:'',fromSrc:false,srcCategory:'',disclosureIndexList:[]})};}
export function parseKap(json,source=KAP_SOURCE,now=Date.now()){
 const rows=JSON.parse(json);if(!Array.isArray(rows)||rows.length>1500)throw Error('INVALID_OR_OVERSIZE_KAP_LIST');const items=[];let invalid=0;
 for(const row of rows){const d=/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(row.publishDate||''),id=row.disclosureIndex;if(!d||!Number.isSafeInteger(id)||id<=0||typeof row.subject!=='string'||!row.subject.trim()){invalid++;continue;}const at=Date.UTC(+d[3],+d[2]-1,+d[1],+d[4]-3,+d[5],+d[6]);if(!Number.isFinite(at)||at>now+60000){invalid++;continue;}
  const symbols=String(row.stockCodes||'').split(/[,;\s]+/).filter(s=>NEWS_COMPANIES[s]),summary=typeof row.summary==='string'?row.summary.trim():'';
  items.push({source_id:source.id,source_record_id:String(id),source_url:'https://www.kap.org.tr/tr/Bildirim/'+id,headline:(String(row.stockCodes||row.kapTitle||'')+' · '+row.subject).slice(0,1500),published_at:new Date(at).toISOString().replace(/\.\d{3}Z$/,'Z'),body:summary.slice(0,14000),body_truncated:summary.length>14000,related_symbols:symbols,provider_sources:['KAP'],headline_only:!summary,summary_only:true,disclosure_class:row.disclosureClass||null,company_title:row.kapTitle||'',attachments_not_read:true,coverage:'PARTIAL_PUBLIC_SUMMARY'});
 }
 if(rows.length&&!items.length)throw Error('KAP_ALL_ROWS_INVALID');return {items,invalid,coverage:'PARTIAL_PUBLIC_SUMMARY'};
}
