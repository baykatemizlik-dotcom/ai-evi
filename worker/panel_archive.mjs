import {json,trtDate} from './cloud_bridge.mjs';
export const quotaFailure=e=>/daily row (read|write) limit|free tier.*daily.*limit/i.test(String(e?.message||e));
export function archivedPanelValue(saved,now=Date.now()){
 if(!saved?.data||!saved.captured_at)return null;
 const d=JSON.parse(JSON.stringify(saved.data));
 Object.assign(d,{panel_archived:true,snapshot_at:saved.captured_at,archive_reason:'D1_DAILY_QUOTA_EXCEEDED',archive_notice:'D1 kotası doldu · son kayıtların arşivi gösteriliyor · güncel akış ve fiyat değildir.',scanner_live:false});
 if(d.status==='ACTIVE')d.status='ARCHIVED_DATA';
 for(const t of d.open_trades||[])t.quote_fresh=false;
 for(const q of [...(d.scalp_sniper_queue||[]),...(d.trend_radar_queue||[])])if(q.status==='READY'&&Date.parse(q.expires_at)<=now)q.status='EXPIRED';
 for(const row of d.opportunities||[]){if(row.queue?.status==='READY'&&Date.parse(row.queue.expires_at)<=now)row.queue.status='EXPIRED';for(const stage of row.stages||[])if(stage.scenario?.status==='OPEN')stage.scenario.quote_stale=true;}
 for(const bot of d.bots||[])bot.panel_stale=true;
 for(const field of ['gemini','openai'])if(d[field])d[field]={...d[field],archived_connection:d[field].connection,connection:'ARCHIVED_STATUS'};
 return d;
}
export async function panelArchiveRead(env,name,produce,now=Date.now()){
 const kv=env.PANEL_ARCHIVE;let saved=null,blockedUntil=0;
 if(kv){try{[saved,blockedUntil]=await Promise.all([kv.get('snapshot:'+name,'json'),kv.get('quota_until')]);}catch{}}
 const archived=()=>{const d=archivedPanelValue(saved,now);return d?json(d):json({error:'D1_DAILY_QUOTA_EXCEEDED',message:'D1 günlük kotası doldu. Kota 03:00 TRT’de yenilenir; bu bölüm için arşiv bulunamadı.'},503);};
 if(Number(blockedUntil)>now)return archived();
 try{const data=await produce();if(kv&&(!saved||now-Date.parse(saved.captured_at)>60000))try{await kv.put('snapshot:'+name,JSON.stringify({captured_at:new Date(now).toISOString(),data}));}catch{}return json(data);}
 catch(e){if(!quotaFailure(e))throw e;if(kv)try{await kv.put('quota_until',String((Math.floor(now/86400000)+1)*86400000));}catch{}return archived();}
}
export async function reconstructionFor(env,date=trtDate(Date.now())){
 if(!/^\d{4}-\d\d-\d\d$/.test(date)||!env.PANEL_ARCHIVE)return null;
 try{return await env.PANEL_ARCHIVE.get('reconstructed:'+date,'json');}catch{return null;}
}
