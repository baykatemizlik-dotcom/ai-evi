// AI Evi: dedicated scheduled backup worker; NOT deployed to production.
// Bind D1 as DB and R2 as BACKUPS. Runs at most once per day via Cloudflare cron.
// Snapshot is NOT a native D1 SQLite backup: it is a versioned JSON export
// of the tables listed below. Verify restore before claiming disaster recovery.
const TABLES=["conversations","decisions","conversation_events"];
const KEEP_DAYS=7;
const MAX_ROWS=20000;
const MAX_BYTES=20*1024*1024;
export default {
 async scheduled(event,env,ctx){ctx.waitUntil(runBackup(env));},
 async fetch(){return new Response("Scheduled backup only",{status:404});}
};
async function runBackup(env){
 if(!env.DB||!env.BACKUPS)throw Error("D1 DB and R2 BACKUPS bindings required");
 const today=new Date().toISOString().slice(0,10);
 const key="ai-evi/v05/"+today+".json";
 if(await env.BACKUPS.head(key))return; // one successful snapshot per day
 const snapshot={format:"ai-evi-v05-json-v1",created_at:new Date().toISOString(),tables:{}};
 let count=0;
 for(const table of TABLES){
   let cursor=0, rows=[];
   while(true){
     // Table names are hard-coded, NOT accepted from user input.
     const page=await env.DB.prepare("SELECT * FROM "+table+" ORDER BY rowid LIMIT 500 OFFSET ?").bind(cursor).all();
     const batch=page.results||[];
     count+=batch.length;
     if(count>MAX_ROWS)throw Error("Export too large, aborting WITHOUT writing incomplete backup");
     rows.push(...batch);cursor+=batch.length;
     if(batch.length<500)break;
   }
   snapshot.tables[table]=rows;
 }
 const body=JSON.stringify(snapshot);
 if(new TextEncoder().encode(body).byteLength>MAX_BYTES)throw Error("Backup exceeds safe size; do not save partial file");
 await env.BACKUPS.put(key,body,{httpMetadata:{contentType:"application/json"},customMetadata:{format:snapshot.format}});
 // Keep 7 daily snapshots. Do not delete anything if today's write fails.
 const objects=await env.BACKUPS.list({prefix:"ai-evi/v05/"});
 let truncated=objects.truncated;
 let deleteKeys=objects.objects.filter(x=>/^ai-evi\/v05\/\d{4}-\d{2}-\d{2}\.json$/.test(x.key)&&x.key<"ai-evi/v05/"+new Date(Date.now()-(KEEP_DAYS-1)*86400000).toISOString().slice(0,10)+".json").map(x=>x.key);
 // Do not prune if the list was truncated: manual maintenance required.
 if(!truncated&&deleteKeys.length)await env.BACKUPS.delete(deleteKeys);
}
