// Market data is ingress-only. The only outbound request is the OpenAI paper referee.
export const validSymbol = symbol => typeof symbol==='string' && /^[A-Z0-9]{3,6}$/.test(symbol);
const FRESH_MS = 35 * 60000;
export const json = (body, status=200) => new Response(JSON.stringify(body), {
 status, headers: {'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}
});
export function sessionOpen(now) {
 const d = new Date(now+3*3600000), minutes = d.getUTCHours()*60+d.getUTCMinutes();
 return d.getUTCDay()>0 && d.getUTCDay()<6 && minutes>=600 && minutes<=1095;
}
export function fresh(row, now) {
 const end = Date.parse(row.bar_time || row.time)+900000;
 return row.feed_type==='INDICATIVE_INTRADAY' && (end-900000)%900000===0 && end<=now && now-end<=FRESH_MS && sessionOpen(now);
}
export function validate(data, now=Date.now()) {
 if (!data || !['YAHOO_INDICATIVE','TWELVE_DATA_XIST_EOD'].includes(data.source) ||
     data.feed_type!==(data.source==='YAHOO_INDICATIVE'?'INDICATIVE_INTRADAY':'EOD') ||
     !Array.isArray(data.bars) || !data.bars.length || data.bars.length>200)
  throw Error('INVALID_ENVELOPE');
 const symbols = new Set(), keys = new Set();
 const bars = data.bars.map(b=>{
  if (!b || !validSymbol(b.symbol) || b.interval!=='15m' || typeof b.time!=='string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(b.time)) throw Error('INVALID_BAR');
  const ts=Date.parse(b.time), values=[b.open,b.high,b.low,b.close,b.volume];
  if (!Number.isFinite(ts) || ts%900000!==0 || ts+900000>now || ts<now-7*86400000 ||
      !values.every(v=>typeof v==='number'&&Number.isFinite(v)) ||
      Math.min(b.open,b.high,b.low,b.close)<=0 || b.volume<0 ||
      b.low>Math.min(b.open,b.close) || b.high<Math.max(b.open,b.close)) throw Error('INVALID_BAR');
  const time=new Date(ts).toISOString(), key=b.symbol+time;
  if(keys.has(key))throw Error('DUPLICATE_BAR'); keys.add(key); symbols.add(b.symbol);
  return {symbol:b.symbol,interval:'15m',time,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume};
 });
 // One symbol/request bounds D1 queries and makes partial provider outages independent.
 if(symbols.size!==1)throw Error('ONE_SYMBOL_PER_REQUEST');
 return {purpose:data.purpose||'MONITOR',run_id:data.run_id||null,source:data.source,feed_type:data.feed_type,bars:bars.sort((a,b)=>a.time.localeCompare(b.time))};
}
export function entryPlan(cash, price) {
 const executed=price*1.002, qty=Math.floor(Math.min(1250,cash)/(executed*1.002));
 return {qty,executed,commission:executed*qty*.002};
}
export function exitPlan(trade, bars) {
 const cost=trade.executed_price*trade.lot_count+trade.commission;
 const tp=cost*1.03/(trade.lot_count*.998*.998), sl=cost*.985/(trade.lot_count*.998*.998);
 for(const b of bars) {
  if(b.bar_time<trade.entry_time)continue;
  // Stop wins when both thresholds occur in a candle; gap stops use the worse open.
  let raw,reason;
  if(b.low<=sl){raw=Math.min(b.open,sl);reason='STOP_NET_1_5_PCT';}
  else if(b.high>=tp){raw=tp;reason='TP_NET_3_PCT';}
  else continue;
  const executed=raw*.998;
  return {executed,reason,time:new Date(Date.parse(b.bar_time)+900000).toISOString(),
   pnl:executed*trade.lot_count*.998-cost};
 }
 return null;
}
export function stageOneMetrics(bars) {
 if(bars.length<21)return null;
 const b=bars.at(-1),prev=bars.slice(-21,-1);
 const avg=prev.reduce((sum,x)=>sum+x.volume,0)/20,spread=b.high-b.low+1e-9;
 const rvol=avg>0?b.volume/avg:0,body=Math.abs(b.close-b.open)/spread,upper_wick=(b.high-b.close)/spread;
 return rvol>=2 && b.close>b.open && body>=.60 && upper_wick<=.20 ? {rvol,body,upper_wick}:null;
}
export function technicalSignal(bars) {
 const metrics=stageOneMetrics(bars);if(!metrics)return null;
 const b=bars.at(-1),prev=bars.slice(-21,-1);
 const sessionBars=bars.filter(x=>(x.bar_time||x.time).slice(0,10)===(b.bar_time||b.time).slice(0,10));
 const total=sessionBars.reduce((sum,x)=>sum+x.volume,0);
 const vwap=total>0?sessionBars.reduce((sum,x)=>sum+(x.high+x.low+x.close)/3*x.volume,0)/total:0;
 const resistance=Math.max(...prev.map(x=>x.high));
 return total>0 && b.close>vwap && b.close>resistance ? {...metrics,vwap,resistance,
  score:metrics.rvol+100*(b.close/resistance-1)+100*(b.close/vwap-1),
  last_candle:{open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume},
  classification:'TECHNICAL_PAPER_ONLY',risk_verified:false}:null;
}
export async function restrictionClear(db,symbol,now) {
 return !!await db.prepare('SELECT symbol FROM bist_funnel_risk WHERE symbol=? AND eligible=1 AND valid_until>?')
  .bind(symbol,new Date(now).toISOString()).first();
}
export function eligibleEntryBar(signal, bars) {
 const earliest = Math.max(Date.parse(signal.bar_time)+900000, Date.parse(signal.observed_at));
 const expiry = Date.parse(signal.expires_at);
 if(!Number.isFinite(earliest)||!Number.isFinite(expiry))return null;
 return bars.find(b=>{const t=Date.parse(b.bar_time);return t%900000===0 && t>=earliest && t<=expiry;})||null;
}
export async function runPaper(db, symbol, now) {
 const rows=await db.prepare("SELECT * FROM bist_bridge_bars WHERE symbol=? AND interval='15m' AND source='YAHOO_INDICATIVE' AND CAST(strftime('%s',bar_time) AS INTEGER)%900=0 ORDER BY bar_time DESC LIMIT 100").bind(symbol).all();
 const bars=(rows.results||[]).reverse(), last=bars.at(-1);
 const result={signals_created:0,opened:0,closed:0,mode:'PAPER_ONLY',risk_verified:false};
 if(!last || !fresh({...last,feed_type:'INDICATIVE_INTRADAY'},now))return {...result,blocked:'STALE_OR_EOD'};
 const positions=await db.prepare("SELECT * FROM virtual_trades WHERE strategy='SCALP' AND status='OPEN' AND symbol=? AND feed_entry_key IS NOT NULL").bind(symbol).all();
 for(const trade of positions.results||[]) {
  const exit=exitPlan(trade,bars);
  if(exit){const r=await db.prepare("UPDATE virtual_trades SET status='CLOSED',exit_price=?,exit_time=?,pnl_net=?,exit_reason=? WHERE id=? AND status='OPEN' RETURNING id")
   .bind(exit.executed,exit.time,exit.pnl,exit.reason,trade.id).first();result.closed+=r?1:0;}
 }
 const pending=await db.prepare("SELECT * FROM bist_feed_signals WHERE symbol=? AND status='PENDING' AND expires_at>=? ORDER BY observed_at DESC LIMIT 1").bind(symbol,new Date(now).toISOString()).first();
 if(pending && await restrictionClear(db,symbol,now) && await db.prepare("SELECT signal_key FROM bist_ai_decisions WHERE signal_key=? AND status='APPROVED' AND model='gpt-4o-mini'").bind(pending.signal_key).first()){
  const next=eligibleEntryBar(pending,bars);
  // Never fill a signal at a price observed before it was generated.
  if(next){
   const account=await db.prepare("SELECT available_cash FROM paper_cash_accounts WHERE strategy='SCALP'").first();
   const slots=await db.prepare("SELECT slot_id,symbol FROM virtual_trades WHERE strategy='SCALP' AND status='OPEN'").all();
   const open=slots.results||[], slot=[1,2].find(s=>!open.some(x=>x.slot_id===s));
   const plan=entryPlan(account?.available_cash||0,next.open);
   if(open.length<2 && slot && !open.some(x=>x.symbol===symbol) && plan.qty>0){
    try{
     const r=await db.prepare("INSERT INTO virtual_trades(strategy,symbol,signal_price,executed_price,lot_count,commission,entry_time,status,slot_id,feed_entry_key) VALUES('SCALP',?,?,?,?,?,?,'OPEN',?,?) ON CONFLICT(feed_entry_key) DO NOTHING RETURNING id")
      .bind(symbol,next.open,plan.executed,plan.qty,plan.commission,next.bar_time,slot,pending.signal_key).first();
     if(r){result.opened=1;
      const trade=await db.prepare("SELECT * FROM virtual_trades WHERE feed_entry_key=?").bind(pending.signal_key).first();
      const exit=exitPlan(trade,bars);
      if(exit){const x=await db.prepare("UPDATE virtual_trades SET status='CLOSED',exit_price=?,exit_time=?,pnl_net=?,exit_reason=? WHERE id=? AND status='OPEN' RETURNING id")
       .bind(exit.executed,exit.time,exit.pnl,exit.reason,trade.id).first();result.closed+=x?1:0;}
     }
    }catch(e){if(!/PAPER_SLOT_BUSY|PAPER_INSUFFICIENT_CASH|PAPER_SIGNAL_NOT_ELIGIBLE/.test(String(e)))throw e;result.entry_deferred='CONCURRENT_OR_EXPIRED';}
   }
  }
 }
 return result;
}
export async function readBody(request) {
 if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw Error('JSON_REQUIRED');
 const reader=request.body?.getReader();if(!reader)throw Error('EMPTY_BODY');
 let size=0,chunks=[];
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
  if(size>100000){await reader.cancel();throw Error('PAYLOAD_TOO_LARGE');}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 return JSON.parse(new TextDecoder().decode(bytes));
}
export async function ingest(request, env, now=Date.now()) {
 if(!env.DB)return json({error:'DB_MISSING'},503);
 let data;try{data=validate(await readBody(request),now);}catch(e){return json({error:e.message||'INVALID_JSON'},e.message==='PAYLOAD_TOO_LARGE'?413:422);}
 const symbol=data.bars[0].symbol, latest=data.bars.at(-1), received=new Date(now).toISOString();
 const inserted=await env.DB.batch([
  env.DB.prepare(`INSERT INTO bist_bridge_bars(symbol,interval,bar_time,open,high,low,close,volume,source,received_at)
   SELECT json_extract(value,'$.symbol'),'15m',json_extract(value,'$.time'),json_extract(value,'$.open'),
   json_extract(value,'$.high'),json_extract(value,'$.low'),json_extract(value,'$.close'),json_extract(value,'$.volume'),?,?
   FROM json_each(?) WHERE true
   ON CONFLICT(symbol,interval,bar_time) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,
    close=excluded.close,volume=excluded.volume,source=excluded.source,received_at=excluded.received_at
   WHERE bist_bridge_bars.source='TWELVE_DATA_XIST_EOD' AND excluded.source='YAHOO_INDICATIVE'`).bind(data.source,received,JSON.stringify(data.bars)),
  env.DB.prepare(`INSERT INTO bist_feed_state(symbol,last_bar_time,source,feed_type,received_at) VALUES(?,?,?,?,?)
   ON CONFLICT(symbol) DO UPDATE SET last_bar_time=excluded.last_bar_time,source=excluded.source,
    feed_type=excluded.feed_type,received_at=excluded.received_at
   WHERE excluded.last_bar_time>bist_feed_state.last_bar_time OR
    (excluded.last_bar_time=bist_feed_state.last_bar_time AND bist_feed_state.feed_type='EOD' AND excluded.feed_type='INDICATIVE_INTRADAY') OR
    CAST(strftime('%s',bist_feed_state.last_bar_time) AS INTEGER)%900!=0`)
   .bind(symbol,latest.time,data.source,data.feed_type,received)
 ]);
 const active=fresh({...latest,feed_type:data.feed_type},now);
 // Run on retries too: a storage success + engine failure can recover safely.
 const engine=active?await runPaper(env.DB,symbol,now):{blocked:'STALE_OR_EOD',opened:0,closed:0,signals_created:0};
 let stage2='NOT_HOT';
 if(active && data.purpose==='HOT_CANDIDATE' && validRunId(data.run_id)) {
  const rows=await env.DB.prepare("SELECT * FROM bist_bridge_bars WHERE symbol=? AND source='YAHOO_INDICATIVE' AND interval='15m' AND CAST(strftime('%s',bar_time) AS INTEGER)%900=0 ORDER BY bar_time DESC LIMIT 100").bind(symbol).all();
  const metrics=technicalSignal((rows.results||[]).reverse());
  if(!await restrictionClear(env.DB,symbol,now))stage2='BLOCKED_RESTRICTIONS';
  else if(metrics){await env.DB.prepare('INSERT OR IGNORE INTO bist_funnel_candidates(run_id,symbol,bar_time,observed_at,score,metrics_json) VALUES(?,?,?,?,?,?)')
   .bind(data.run_id,symbol,latest.time,received,metrics.score,JSON.stringify(metrics)).run();stage2='MOMENTUM_PASSED';}
  else stage2='MOMENTUM_REJECTED';
 }
 return json({ok:true,status:active?'ACTIVE':'BLOCKED_MARKET_DATA_UNAVAILABLE',
  source:data.source,market_feed_verified:false,bar_rows:data.bars.length,new_bars:inserted[0].meta.changes,
  engine,stage2,orders_sent:0});
}
export const validRunId = id => typeof id==='string' && /^[A-Za-z0-9:_-]{1,80}$/.test(id);
export async function riskIngest(request,env,now=Date.now()) {
 const body=await readBody(request),symbols=body.symbols,safe=body.eligible_symbols;
 if(!Array.isArray(symbols)||!symbols.length||!symbols.every(validSymbol)||new Set(symbols).size!==symbols.length ||
  !Array.isArray(safe)||!safe.every(x=>symbols.includes(x)))return json({error:'INVALID_RISK_UNIVERSE'},422);
 const r=body.risk,source='https://www.borsaistanbul.com/erd/menkul_tedbir_listesi.csv';
 let eligible=new Set(),stamp=new Date(now).toISOString(),expiry=stamp;
 if(body.risk_status==='VERIFIED_OFFICIAL_RESTRICTIONS') {
  const asOf=Date.parse(r?.as_of),until=Date.parse(r?.valid_until);
  if(r?.source!==source || !Number.isFinite(asOf)||asOf>now||now-asOf>86400000||
   !Number.isFinite(until)||until<=now||until>now+86400000)return json({error:'INVALID_OR_STALE_RISK'},422);
  eligible=new Set(safe);stamp=new Date(asOf).toISOString();expiry=new Date(until).toISOString();
 }
 const rows=symbols.map(symbol=>({symbol,eligible:eligible.has(symbol)?1:0}));
 await env.DB.prepare(`INSERT INTO bist_funnel_risk(symbol,eligible,as_of,valid_until,source)
  SELECT json_extract(value,'$.symbol'),json_extract(value,'$.eligible'),?,?,? FROM json_each(?) WHERE true
  ON CONFLICT(symbol) DO UPDATE SET eligible=excluded.eligible,as_of=excluded.as_of,valid_until=excluded.valid_until,source=excluded.source`)
  .bind(stamp,expiry,source,JSON.stringify(rows)).run();
 return json({ok:true,total:symbols.length,eligible:eligible.size,restrictions_verified:eligible.size>0});
}
export async function monitorSymbols(env,now=Date.now()) {
 const rows=await env.DB.prepare("SELECT symbol FROM virtual_trades WHERE strategy='SCALP' AND status='OPEN' UNION SELECT symbol FROM bist_feed_signals WHERE status='PENDING' AND expires_at>=?")
  .bind(new Date(now).toISOString()).all();return json({symbols:(rows.results||[]).map(x=>x.symbol)});
}
export async function reportIngest(request,env,now=Date.now()) {
 const b=await readBody(request),fields=['shard','universe_total','eligible_total','assigned','fetched','hot','posted','errors'];
 if(!validRunId(b.run_id)||!fields.every(k=>Number.isInteger(b[k])&&b[k]>=0)||b.shard>7||
  b.fetched>b.assigned||b.eligible_total>b.universe_total||b.hot>b.fetched||b.posted>b.hot ||
  (b.last_bar_time!==null&&(!Number.isFinite(Date.parse(b.last_bar_time))||Date.parse(b.last_bar_time)%900000!==0||Date.parse(b.last_bar_time)+900000>now)))
  return json({error:'INVALID_SCAN_REPORT'},422);
 await env.DB.prepare(`INSERT INTO bist_funnel_reports(run_id,shard,universe_total,eligible_total,assigned,fetched,hot,posted,errors,last_bar_time,completed_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,shard) DO UPDATE SET fetched=excluded.fetched,hot=excluded.hot,posted=excluded.posted,errors=excluded.errors,last_bar_time=excluded.last_bar_time,completed_at=excluded.completed_at`)
  .bind(b.run_id,...fields.map(k=>b[k]),b.last_bar_time,new Date(now).toISOString()).run();return json({ok:true});
}
export const AI_MODEL='gpt-4o-mini';
export async function aiVerdict(env,candidate,risk,network=globalThis.fetch) {
 if(!env.OPENAI_API_KEY)throw Error('OPENAI_KEY_MISSING');
 const m=JSON.parse(candidate.metrics_json);
 if(!Number.isFinite(m.rvol)||m.rvol<2||!Number.isFinite(m.body)||m.body<.6||!Number.isFinite(m.upper_wick)||m.upper_wick>.2||risk?.eligible!==1||!m.last_candle||!(m.last_candle.close>m.last_candle.open&&m.last_candle.close>m.vwap&&m.last_candle.close>m.resistance))
  throw Error('AI_INPUT_NOT_ELIGIBLE');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
 try{
  const response=await network('https://api.openai.com/v1/chat/completions',{
   method:'POST',redirect:'error',signal:controller.signal,
   headers:{Authorization:'Bearer '+env.OPENAI_API_KEY,'Content-Type':'application/json'},
   body:JSON.stringify({model:AI_MODEL,temperature:0,max_completion_tokens:200,
    messages:[{role:'system',content:'Sanal BIST scalp teknik tetik hakemisin. Sadece verilen doğrulanmış sayısal veriyi değerlendir. RVOL>=2, yeşil mum, gövde>=0.60, üst fitil<=0.20, 20-bar breakout ve seans VWAP üstü kapanış gereklidir. Resmi VBTS/tedbir listesi güncel ve uygun değilse onay verme. Haber/ceza/mutlak manipülasyon yokluğu için dış araştırma yapılmadı; bunu uydurma, kesin güvence verme. OHLCV wash trade kanıtı değildir. Veriler tutarsız/eksikse veya teknik kırılım zayıfsa onay=false. Diğer durumda teknik sanal takip için onay verebilirsin. Kısa Türkçe neden yaz. Gerçek emir verme, gelecekteki bar hakkında tahmin uydurma.'},
     {role:'user',content:JSON.stringify({symbol:candidate.symbol,bar_time:candidate.bar_time,metrics:m,green_candle:true,breakout_passed:true,vwap_passed:true,
      vbts:{eligible:risk.eligible===1,source:risk.source,as_of:risk.as_of,valid_until:risk.valid_until},other_penalty_news_checked:false})}],
    response_format:{type:'json_schema',json_schema:{name:'bist_paper_verdict',strict:true,schema:{type:'object',properties:{onay:{type:'boolean'},neden:{type:'string'}},required:['onay','neden'],additionalProperties:false}}}})
  });
  if(!response.ok){await response.body?.cancel();throw Error('OPENAI_HTTP_'+response.status);}
  // Bound even an unexpected upstream response; never log its body or credentials.
  const reader=response.body.getReader();let size=0,text='';const decoder=new TextDecoder();
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>64000){await reader.cancel();throw Error('OPENAI_RESPONSE_TOO_LARGE');}text+=decoder.decode(value,{stream:true});}
  text+=decoder.decode();const data=JSON.parse(text),choice=data.choices?.[0];
  if(choice?.finish_reason!=='stop'||choice.message?.refusal)throw Error('OPENAI_REFUSAL_OR_INCOMPLETE');
  const result=JSON.parse(choice.message.content);
  if(!result||typeof result.onay!=='boolean'||typeof result.neden!=='string'||!result.neden.trim()||result.neden.length>1000||Object.keys(result).sort().join(',')!=='neden,onay')throw Error('OPENAI_BAD_VERDICT');
  return {...result,input_tokens:Number.isInteger(data.usage?.prompt_tokens)?data.usage.prompt_tokens:0,
   output_tokens:Number.isInteger(data.usage?.completion_tokens)?data.usage.completion_tokens:0};
 }finally{clearTimeout(timer);}
}
export async function judgeCandidate(env,c,now,network) {
 const key=c.symbol+':'+c.bar_time,wallStart=Date.now();
 const claimed=await env.DB.prepare("INSERT OR IGNORE INTO bist_ai_decisions(signal_key,run_id,symbol,bar_time,model,status,reason,created_at) VALUES(?,?,?,?,?,'PENDING','AWAITING_VERDICT',?)")
  .bind(key,c.run_id,c.symbol,c.bar_time,AI_MODEL,new Date(now).toISOString()).run();
 if(claimed.meta.changes){
  let status='ERROR',reason='AI_UNAVAILABLE',input=0,output=0;
  try{
   const risk=await env.DB.prepare('SELECT * FROM bist_funnel_risk WHERE symbol=? AND eligible=1 AND valid_until>?').bind(c.symbol,new Date(now).toISOString()).first();
   if(!risk)throw Error('RESTRICTIONS_EXPIRED');
   const verdict=await aiVerdict(env,c,risk,network);status=verdict.onay?'APPROVED':'REJECTED';reason=verdict.neden;input=verdict.input_tokens;output=verdict.output_tokens;
  }catch(e){reason=/^(OPENAI_[A-Z_0-9]+|AI_INPUT_NOT_ELIGIBLE|RESTRICTIONS_EXPIRED)$/.test(e.message)?e.message:'OPENAI_NETWORK_OR_INVALID_RESPONSE';}
  await env.DB.prepare("UPDATE bist_ai_decisions SET status=?,reason=?,completed_at=?,input_tokens=?,output_tokens=? WHERE signal_key=? AND status='PENDING'")
   .bind(status,reason,new Date(now+Math.max(0,Date.now()-wallStart)).toISOString(),input,output,key).run();
  console.log(JSON.stringify({event:'BIST_AI_DECISION',symbol:c.symbol,status,model:AI_MODEL}));
 }
 return await env.DB.prepare('SELECT * FROM bist_ai_decisions WHERE signal_key=?').bind(key).first();
}
export async function finalize(request,env,now=Date.now(),network=globalThis.fetch) {
 const b=await readBody(request);if(!validRunId(b.run_id))return json({error:'INVALID_RUN'},422);
 if(!env.OPENAI_API_KEY)return json({error:'OPENAI_KEY_MISSING',signals_created:0},503);
 const rows=await env.DB.prepare(`SELECT c.* FROM bist_funnel_candidates c JOIN bist_funnel_risk r ON r.symbol=c.symbol
  WHERE c.run_id=? AND r.eligible=1 AND r.valid_until>? AND c.bar_time>=?
  ORDER BY c.score DESC,c.symbol ASC`).bind(b.run_id,new Date(now).toISOString(),new Date(now-50*60000).toISOString()).all();
 // No candidate-count cap: five concurrent calls are transport throttling only.
 const candidates=(rows.results||[]).filter(c=>fresh({bar_time:c.bar_time,feed_type:'INDICATIVE_INTRADAY'},now));
 const decisions=new Array(candidates.length);let cursor=0;
 await Promise.all(Array.from({length:Math.min(5,candidates.length)},async()=>{
  while(cursor<candidates.length){const index=cursor++;decisions[index]=await judgeCandidate(env,candidates[index],now,network);}
 }));
 let created=0;const selected=[];
 for(let i=0;i<candidates.length;i++){
  const c=candidates[i],decision=decisions[i];if(decision?.status!=='APPROVED')continue;
  // After a slow API response, recheck freshness/risk. Never use request-start time for entry.
  const observed=Math.max(now,Date.parse(decision.completed_at)||now);
  if(!fresh({bar_time:c.bar_time,feed_type:'INDICATIVE_INTRADAY'},observed)||!await restrictionClear(env.DB,c.symbol,observed))continue;
  const result=await env.DB.prepare("INSERT OR IGNORE INTO bist_feed_signals(signal_key,symbol,bar_time,observed_at,expires_at,source,metrics_json) VALUES(?,?,?,?,?,'YAHOO_INDICATIVE',?)")
   .bind(decision.signal_key,c.symbol,c.bar_time,new Date(observed).toISOString(),new Date(observed+60*60000).toISOString(),c.metrics_json).run();created+=result.meta.changes;selected.push(c.symbol);
 }
 return json({ok:true,run_id:b.run_id,model:AI_MODEL,candidates_reviewed:candidates.length,selected,signals_created:created,
  rejected:decisions.filter(d=>d?.status==='REJECTED').length,errors:decisions.filter(d=>d?.status==='ERROR'||d?.status==='PENDING').length,orders_sent:0});
}
export async function aiStatus(env) {
 const last=await env.DB.prepare("SELECT symbol,status,reason,completed_at FROM bist_ai_decisions WHERE status!='PENDING' ORDER BY completed_at DESC LIMIT 1").first();
 return {model:AI_MODEL,connection:!env.OPENAI_API_KEY?'MISSING_KEY':last&&['APPROVED','REJECTED'].includes(last.status)?'CONNECTED':last?.status==='ERROR'?'ERROR':'CONFIGURED',last_decision:last||null};
}
export async function feedStatus(db,now=Date.now()) {
 const [rows,reports]=await Promise.all([db.prepare('SELECT * FROM bist_feed_state').all(),
  db.prepare('SELECT * FROM bist_funnel_reports WHERE run_id=(SELECT run_id FROM bist_funnel_reports ORDER BY completed_at DESC LIMIT 1)').all()]);
 const active=(rows.results||[]).filter(x=>fresh({bar_time:x.last_bar_time,feed_type:x.feed_type},now));
 const scan=reports.results||[],valid=scan.filter(x=>fresh({bar_time:x.last_bar_time,feed_type:'INDICATIVE_INTRADAY'},now));
 const scanning=active.length>0||valid.some(x=>x.fetched>0);
 return {status:scanning?'ACTIVE':'BLOCKED_MARKET_DATA_UNAVAILABLE',scanner_live:scanning,
  active_symbols:active.length,scanned_symbols:valid.reduce((n,x)=>n+x.fetched,0),
  universe_total:scan[0]?.universe_total||0,eligible_total:scan[0]?.eligible_total||0,
  stage1_hot:scan.reduce((n,x)=>n+x.hot,0),shards_completed:scan.length,
  source:'GITHUB_ACTIONS_CLOUD_BRIDGE',market_feed_verified:false,paper_only:true,risk_verified:false,
  last_received:[...(rows.results||[]).map(x=>x.received_at),...scan.map(x=>x.completed_at)].sort().at(-1)||null};
}
