import {json} from './cloud_bridge.mjs';
// Separate namespaces: never write any existing engine/cash/queue table.
async function trialBody(request){
 if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw Error('JSON_REQUIRED');
 const reader=request.body?.getReader();if(!reader)throw Error('EMPTY_BODY');
 let n=0,s='';const d=new TextDecoder();while(true){const x=await reader.read();if(x.done)break;n+=x.value.length;if(n>200000){await reader.cancel();throw Error('PAYLOAD_TOO_LARGE');}s+=d.decode(x.value,{stream:true});}return JSON.parse(s+d.decode());
}
export const TRIAL_IDS=['DENEME_1','DENEME_2'];
export async function trialOverview(db,privateState=false){
 const rows=await db.prepare('SELECT id,revision,state_json,updated_at FROM research_paper_trials ORDER BY id').all();
 return {paper_only:true,real_orders_enabled:false,mode:'YAHOO_DELAYED_PAPER_ADAPTATION',bots:(rows.results||[]).map(r=>{const s=JSON.parse(r.state_json);return {...s,id:r.id,revision:r.revision,updated_at:r.updated_at,...(!privateState?{ledger:undefined}:{}),panel_stale:!s.last_received_at||Date.now()-Date.parse(s.last_received_at)>15*60000};})};
}
export async function trialFeed(request,env){
 if(request.method==='GET')return json({...await trialOverview(env.DB,true),risk:(await env.DB.prepare("SELECT symbol,eligible,valid_until FROM bist_funnel_risk WHERE valid_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')").all()).results||[]});
 const b=await trialBody(request);
 if(!TRIAL_IDS.includes(b.id)||!Number.isSafeInteger(b.expected_revision)||b.expected_revision<0||!b.state||b.state.initial_cash!=='25000'||b.state.paper_only!==true||b.state.mode!=='YAHOO_DELAYED_PAPER_ADAPTATION')return json({error:'INVALID_TRIAL_STATE'},422);
 const s=b.state;
 if(!/^\d+(?:\.\d+)?$/.test(s.cash)||!Array.isArray(s.ledger)||s.ledger.length>2000||!Array.isArray(s.open_trades)||s.open_trades.length>1||!['WAITING_TODAY_DATA','RUNNING_DELAYED_PAPER','BLOCKED_INCOMPLETE_UNIVERSE','BLOCKED_STALE_DATA','BLOCKED_RISK_DATA','ERROR'].includes(s.status))return json({error:'INVALID_TRIAL_LEDGER'},422);
 const current=await env.DB.prepare('SELECT state_json FROM research_paper_trials WHERE id=?').bind(b.id).first();
 if(!current)return json({error:'TRIAL_NOT_INSTALLED'},409);
 const old=JSON.parse(current.state_json);
 if(s.activation_epoch!==old.activation_epoch||s.source_start_minute!==old.source_start_minute||s.arm!==old.arm||(old.cursor!==null&&(s.cursor===null||s.cursor<old.cursor))||s.ledger.length<old.ledger.length||JSON.stringify(s.ledger.slice(0,old.ledger.length))!==JSON.stringify(old.ledger))return json({error:'IMMUTABLE_TRIAL_HISTORY'},422);
 const r=await env.DB.prepare("UPDATE research_paper_trials SET state_json=?,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND revision=?").bind(JSON.stringify(s),b.id,b.expected_revision).run();
 return r.meta.changes===1?json({ok:true,revision:b.expected_revision+1,paper_only:true}):json({error:'REVISION_CONFLICT'},409);
}
