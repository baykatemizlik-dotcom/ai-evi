import {tickStrategies,fillStrategy,enqueueScalp,strategyMonitor,saveQuote} from './strategy_engines.mjs';
// Market data is ingress-only. The only outbound request is the OpenAI paper referee.
export const validSymbol = symbol => typeof symbol==='string' && /^[A-Z0-9]{3,6}$/.test(symbol);
const FRESH_MS = 35 * 60000;
export const MIN_DAILY_TURNOVER_TL = 40_000_000;
export const GEMINI_MODEL = 'gemini-3.1-flash-lite';
const TRT = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',weekday:'short',hourCycle:'h23'});
export function trtParts(now){return Object.fromEntries(TRT.formatToParts(new Date(now)).map(x=>[x.type,x.value]));}
export const json = (body, status=200) => new Response(JSON.stringify(body), {
 status, headers: {'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}
});
export function sessionOpen(now) {
 const p=trtParts(now),minutes=Number(p.hour)*60+Number(p.minute);
 return !['Sat','Sun'].includes(p.weekday) && minutes>=600 && minutes<=1085; // 18:05 TRT
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
 const eligible=[...bars].filter(b=>Date.parse(b.bar_time)>=Date.parse(trade.entry_time)).sort((a,b)=>Date.parse(a.bar_time)-Date.parse(b.bar_time));
 for(const b of eligible) {
  // Stop wins when both thresholds occur in a candle; gap stops use the worse open.
  let raw,reason;
  if(b.low<=sl){raw=Math.min(b.open,sl);reason='STOP_NET_1_5_PCT';}
  else if(b.high>=tp){raw=tp;reason='TP_NET_3_PCT';}
  else continue;
  const executed=raw*.998;
  return {executed,reason,quote_time:b.bar_time,time:new Date(Date.parse(b.bar_time)+900000).toISOString(),
   pnl:executed*trade.lot_count*.998-cost};
 }
 // Recover historical TP/SL first; otherwise use the latest available closed candle.
 const last=eligible.at(-1);
 if(last && Date.parse(last.bar_time)+900000-Date.parse(trade.entry_time)>=3600000 && Number.isFinite(last.close) && last.close>0){
  const executed=last.close*.998;
  return {executed,reason:'TIME_EXIT',quote_time:last.bar_time,time:new Date(Date.parse(last.bar_time)+900000).toISOString(),pnl:executed*trade.lot_count*.998-cost};
 }
 return null;
}
export function stageOneMetrics(bars) {
 if(bars.length<21)return null;
 const b=bars.at(-1),prev=bars.slice(-21,-1);
 const avg=prev.reduce((sum,x)=>sum+x.volume,0)/20,spread=b.high-b.low+1e-9;
 const rvol=avg>0?b.volume/avg:0,body=Math.abs(b.close-b.open)/spread,upper_wick=(b.high-b.close)/spread;
 const daily_turnover_tl_estimate=dailyTurnover(bars);
 return rvol>=2 && b.close>b.open && body>=.60 && upper_wick<=.20 && daily_turnover_tl_estimate>=MIN_DAILY_TURNOVER_TL ? {rvol,body,upper_wick,daily_turnover_tl_estimate,turnover_source:'CLOSED_SESSION_CLOSE_X_VOLUME'}:null;
}
export function sameSession(bars){const last=bars.at(-1);if(!last)return [];const date=trtDate(Date.parse(last.bar_time||last.time));return bars.filter(b=>{const t=Date.parse(b.bar_time||b.time),p=trtParts(t),minute=Number(p.hour)*60+Number(p.minute);return t<=Date.parse(last.bar_time||last.time)&&trtDate(t)===date&&minute>=600&&minute<1085;});}
export function dailyTurnover(bars){return sameSession(bars).reduce((sum,b)=>sum+b.close*b.volume,0);}
export function technicalSignal(bars) {
 const metrics=stageOneMetrics(bars);if(!metrics)return null;
 const b=bars.at(-1),prev=bars.slice(-21,-1);
 const sessionBars=sameSession(bars);
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
export async function runPaper(db,symbol,now){return (await tickStrategies(db,now)).scalp;}
export async function runSniper(db,now){return (await tickStrategies(db,now)).trend;}
export function entryWindow(now){const p=trtParts(now);return sessionOpen(now)&&Number(p.hour)*60+Number(p.minute)<1060;}
export function trtDate(now){const p=trtParts(now);return `${p.year}-${p.month}-${p.day}`;}
export async function symbolBars(db,symbol,now=Date.now()){
 // Keep ALL persisted intervening bars from the earliest open position, not only the latest 100.
 const rows=await db.prepare(`SELECT * FROM bist_bridge_bars WHERE symbol=? AND interval='15m' AND source='YAHOO_INDICATIVE'
 AND CAST(strftime('%s',bar_time) AS INTEGER)%900=0 AND julianday(bar_time)+15.0/1440<=julianday(?)
 AND bar_time>=MIN(?,COALESCE((SELECT MIN(entry_time) FROM virtual_trades WHERE symbol=? AND status='OPEN'),?)) ORDER BY bar_time`)
 .bind(symbol,new Date(now).toISOString(),new Date(now-7*86400000).toISOString(),symbol,new Date(now-7*86400000).toISOString()).all();return rows.results||[];
}
export async function closePaper(db,trade,exit,now=Date.now()){
 const r=await db.batch([db.prepare("UPDATE virtual_trades SET status='CLOSED',exit_price=?,exit_time=?,pnl_net=?,exit_reason=? WHERE id=? AND status='OPEN'").bind(exit.executed,exit.time,exit.pnl,exit.reason,trade.id),
 db.prepare(`INSERT OR IGNORE INTO bist_exit_audit(trade_id,exit_bar_time,exit_observed_at,exit_reason) SELECT id,?,?,? FROM virtual_trades WHERE id=? AND status='CLOSED' AND exit_time=? AND exit_reason=?`).bind(exit.quote_time||null,new Date(now).toISOString(),exit.reason,trade.id,exit.time,exit.reason)]);
 return r[0].meta.changes>0;
}
export async function entryApproved(db,key,bars,now){
 if(dailyTurnover(bars)<MIN_DAILY_TURNOVER_TL)return false;
 return !!await db.prepare("SELECT signal_key FROM bist_gemini_decisions WHERE signal_key=? AND status='APPROVED' AND model=? AND completed_at<=?").bind(key,GEMINI_MODEL,new Date(now).toISOString()).first();
}
export async function enforceSessionClose(db,now=Date.now()){
 const result=await tickStrategies(db,now);
 const p=trtParts(now);if(Number(p.hour)*60+Number(p.minute)>=1085)await dailyReport(db,now);
 return result;
}
export async function dailyReport(db,now=Date.now()){
 const date=trtDate(now),start=date+'T00:00:00',end=date+'T23:59:59';
 const [trades,ai,cash,queue]=await Promise.all([
  db.prepare("SELECT strategy,COUNT(*) exits,SUM(pnl_net) pnl,SUM(CASE WHEN pnl_net>0 THEN 1 ELSE 0 END) wins FROM strategy_exit_legs WHERE datetime(exit_time,'+3 hours') BETWEEN ? AND ? GROUP BY strategy").bind(start.replace('T',' '),end.replace('T',' ')).all(),
  db.prepare("SELECT status,COUNT(*) n,SUM(input_tokens) input_tokens,SUM(output_tokens) output_tokens FROM bist_ai_decisions WHERE substr(datetime(created_at,'+3 hours'),1,10)=? GROUP BY status").bind(date).all(),
  db.prepare('SELECT strategy,available_cash FROM paper_cash_accounts').all(),db.prepare("SELECT 'SCALP' strategy,status,COUNT(*) n FROM scalp_sniper_queue GROUP BY status UNION ALL SELECT 'SWING',status,COUNT(*) n FROM trend_radar_queue GROUP BY status").all()]);
 const report={trt_date:date,generated_at:new Date(now).toISOString(),paper_only:true,trades:trades.results,ai:ai.results,cash:cash.results,standby:queue.results};
 await db.prepare('INSERT INTO bist_daily_reports(trt_date,generated_at,report_json) VALUES(?,?,?) ON CONFLICT(trt_date) DO UPDATE SET generated_at=excluded.generated_at,report_json=excluded.report_json').bind(date,report.generated_at,JSON.stringify(report)).run();return report;
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
 let data,body;try{body=await readBody(request);data=validate(body,now);}catch(e){return json({error:e.message||'INVALID_JSON'},e.message==='PAYLOAD_TOO_LARGE'?413:422);}
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
 // Save only the independently timestamped provider quote. A bar close is not a live quote.
 await saveQuote(env.DB,symbol,body.quote,now);
 const engines=await tickStrategies(env.DB,now),engine=engines.scalp,sniper=engines.trend,session={scalp_close_at:'17:40',trend_overnight:true};
 let stage2='NOT_HOT';
 if(active && data.purpose==='HOT_CANDIDATE' && validRunId(data.run_id)) {
  const rows=await env.DB.prepare("SELECT * FROM bist_bridge_bars WHERE symbol=? AND source='YAHOO_INDICATIVE' AND interval='15m' AND bar_time<=? AND CAST(strftime('%s',bar_time) AS INTEGER)%900=0 ORDER BY bar_time DESC LIMIT 100").bind(symbol,latest.time).all();
  const metrics=technicalSignal((rows.results||[]).reverse());
  if(!await restrictionClear(env.DB,symbol,now))stage2='BLOCKED_RESTRICTIONS';
  else if(metrics){await env.DB.prepare('INSERT OR IGNORE INTO bist_funnel_candidates(run_id,symbol,bar_time,observed_at,score,metrics_json) VALUES(?,?,?,?,?,?)')
   .bind(data.run_id,symbol,latest.time,received,metrics.score,JSON.stringify(metrics)).run();stage2='MOMENTUM_PASSED';}
  else stage2='MOMENTUM_REJECTED';
 }
 return json({ok:true,status:active?'ACTIVE':'BLOCKED_MARKET_DATA_UNAVAILABLE',bar_time:latest.time,
  source:data.source,market_feed_verified:false,bar_rows:data.bars.length,new_bars:inserted[0].meta.changes,
  engine,sniper,session,stage2,orders_sent:0});
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
export async function monitorSymbols(env,now=Date.now()){return json(await strategyMonitor(env.DB,now));}
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
export async function geminiDecision(request,env,now=Date.now()){
 const query=new URL(request.url).searchParams;
 const b=request.method==='GET'?Object.fromEntries(query):await readBody(request);
 const probe=b.purpose==='PROBE',key=probe?'PROBE:'+trtDate(now):b.symbol+':'+b.bar_time;
 let c,r;
 if(!probe){
  if(!validRunId(b.run_id)||!validSymbol(b.symbol)||!Number.isFinite(Date.parse(b.bar_time)))return json({error:'INVALID_GEMINI_CANDIDATE'},422);
  c=await env.DB.prepare('SELECT * FROM bist_funnel_candidates WHERE run_id=? AND symbol=? AND bar_time=?').bind(b.run_id,b.symbol,b.bar_time).first();
  r=await env.DB.prepare('SELECT * FROM bist_funnel_risk WHERE symbol=?').bind(b.symbol).first();
  if(!c||!fresh({bar_time:c.bar_time,feed_type:'INDICATIVE_INTRADAY'},now)||!await restrictionClear(env.DB,b.symbol,now)||JSON.parse(c.metrics_json).daily_turnover_tl_estimate<MIN_DAILY_TURNOVER_TL)return json({error:'GEMINI_CANDIDATE_NOT_ELIGIBLE'},409);
 }
 const cached=await env.DB.prepare('SELECT * FROM bist_gemini_decisions WHERE signal_key=?').bind(key).first();
 if(request.method==='GET')return json({cached:cached?.model===GEMINI_MODEL?cached:null,candidate:c?{symbol:c.symbol,bar_time:c.bar_time,metrics:JSON.parse(c.metrics_json),vbts:r}:null,model:GEMINI_MODEL});
 if(cached&&cached.model===GEMINI_MODEL&&cached.status!=='ERROR')return json({ok:true,cached:true,status:cached.status});
 const v=b.verdict;
 if(b.model!==GEMINI_MODEL||!['APPROVED','REJECTED','ERROR'].includes(b.status)||
  !v||typeof v.approved!=='boolean'||!Number.isInteger(v.confidence)||v.confidence<0||v.confidence>100||typeof v.reason!=='string'||!v.reason.trim()||v.reason.length>1000||
  Object.keys(v).sort().join(',')!=='approved,confidence,reason'||(b.status==='APPROVED')!==v.approved||b.status==='ERROR'&&v.confidence!==0)return json({error:'INVALID_GEMINI_VERDICT'},422);
 await env.DB.prepare(`INSERT INTO bist_gemini_decisions VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(signal_key) DO UPDATE SET model=excluded.model,status=excluded.status,confidence=excluded.confidence,reason=excluded.reason,completed_at=excluded.completed_at WHERE bist_gemini_decisions.status='ERROR' OR bist_gemini_decisions.model<>excluded.model`)
  .bind(key,probe?'PROBE':b.run_id,probe?'PROBE':c.symbol,probe?new Date(now).toISOString():c.bar_time,GEMINI_MODEL,b.status,v.confidence,v.reason,new Date(now).toISOString()).run();
 return json({ok:true,status:b.status});
}
export async function geminiStatus(env){
 const last=await env.DB.prepare('SELECT symbol,status,reason,model,completed_at FROM bist_gemini_decisions ORDER BY completed_at DESC LIMIT 1').first();
 return {model:GEMINI_MODEL,execution:'GITHUB_ACTIONS',connection:last?last.status==='ERROR'?'ERROR':'CONNECTED':'AWAITING_CLOUD_PROBE',last_decision:last||null};
}
export async function aiVerdict(env,candidate,risk,network=(...args)=>globalThis.fetch(...args)) {
 const apiKey=typeof env.OPENAI_API_KEY==='string'?env.OPENAI_API_KEY.trim():'';
 if(!apiKey)throw Error('OPENAI_KEY_MISSING');
 if(/[^\x21-\x7e]/.test(apiKey))throw Error('OPENAI_KEY_FORMAT_ERROR');
 const m=JSON.parse(candidate.metrics_json);
 if(!Number.isFinite(m.daily_turnover_tl_estimate)||m.daily_turnover_tl_estimate<MIN_DAILY_TURNOVER_TL||!Number.isFinite(m.rvol)||m.rvol<2||!Number.isFinite(m.body)||m.body<.6||!Number.isFinite(m.upper_wick)||m.upper_wick>.2||risk?.eligible!==1||!m.last_candle||!(m.last_candle.close>m.last_candle.open&&m.last_candle.close>m.vwap&&m.last_candle.close>m.resistance))
  throw Error('AI_INPUT_NOT_ELIGIBLE');
 let stage='FETCH';const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
 try{
  const response=await network('https://api.openai.com/v1/chat/completions',{
   method:'POST',redirect:'manual',signal:controller.signal,
   headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},
   body:JSON.stringify({model:AI_MODEL,temperature:0,max_completion_tokens:200,
    messages:[{role:'system',content:'Sanal BIST scalp teknik tetik hakemisin. Sadece verilen doğrulanmış sayısal veriyi değerlendir. RVOL>=2, yeşil mum, gövde>=0.60, üst fitil<=0.20, 20-bar breakout ve seans VWAP üstü kapanış gereklidir. Resmi VBTS/tedbir listesi güncel ve uygun değilse onay verme. Haber/ceza/mutlak manipülasyon yokluğu için dış araştırma yapılmadı; bunu uydurma, kesin güvence verme. OHLCV wash trade kanıtı değildir. Veriler tutarsız/eksikse veya teknik kırılım zayıfsa onay=false. Diğer durumda teknik sanal takip için onay verebilirsin. Kısa Türkçe neden ve 0-100 arasında guven skoru yaz. Guven bir model değerlendirmesidir, kalibre edilmiş başarı olasılığı değildir. Gerçek emir verme, gelecekteki bar hakkında tahmin uydurma.'},
     {role:'user',content:JSON.stringify({symbol:candidate.symbol,bar_time:candidate.bar_time,metrics:m,green_candle:true,breakout_passed:true,vwap_passed:true,
      vbts:{eligible:risk.eligible===1,source:risk.source,as_of:risk.as_of,valid_until:risk.valid_until},other_penalty_news_checked:false})}],
    response_format:{type:'json_schema',json_schema:{name:'bist_paper_verdict',strict:true,schema:{type:'object',properties:{onay:{type:'boolean'},neden:{type:'string'},guven:{type:'integer',minimum:0,maximum:100}},required:['onay','neden','guven'],additionalProperties:false}}}})
  });
  if(!response.ok){await response.body?.cancel();throw Error('OPENAI_HTTP_'+response.status);}
  // Bound even an unexpected upstream response; never log its body or credentials.
  stage='READ_RESPONSE';const reader=response.body.getReader();let size=0,text='';const decoder=new TextDecoder();
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>64000){await reader.cancel();throw Error('OPENAI_RESPONSE_TOO_LARGE');}text+=decoder.decode(value,{stream:true});}
  stage='PARSE_RESPONSE';text+=decoder.decode();const data=JSON.parse(text),choice=data.choices?.[0];
  if(choice?.finish_reason!=='stop'||choice.message?.refusal)throw Error('OPENAI_REFUSAL_OR_INCOMPLETE');
  const result=JSON.parse(choice.message.content);
  if(!result||typeof result.onay!=='boolean'||typeof result.neden!=='string'||!result.neden.trim()||result.neden.length>1000||!Number.isInteger(result.guven)||result.guven<0||result.guven>100||Object.keys(result).sort().join(',')!=='guven,neden,onay')throw Error('OPENAI_BAD_VERDICT');
  return {...result,input_tokens:Number.isInteger(data.usage?.prompt_tokens)?data.usage.prompt_tokens:0,
   output_tokens:Number.isInteger(data.usage?.completion_tokens)?data.usage.completion_tokens:0};
 }catch(e){if(/^OPENAI_|^AI_INPUT_/.test(e.message))throw e;const kind=e.name==='AbortError'?'TIMEOUT':e.name==='TypeError'?'TYPE_ERROR':e.name==='SyntaxError'?'BAD_JSON':'RUNTIME_ERROR';const detail=kind==='TYPE_ERROR'?String(e.message).replaceAll(apiKey,'[redacted]').replaceAll(env.OPENAI_API_KEY||apiKey,'[redacted]').replace(/sk-[^\s\"'<>]+/g,'[redacted]').slice(0,180):'';throw Error('OPENAI_'+stage+'_'+kind+(detail?': '+detail:''));}finally{clearTimeout(timer);}
}
export async function judgeCandidate(env,c,now,network) {
 const key=c.symbol+':'+c.bar_time,wallStart=Date.now();
 const claimed=await env.DB.prepare("INSERT OR IGNORE INTO bist_ai_decisions(signal_key,run_id,symbol,bar_time,model,status,reason,created_at) VALUES(?,?,?,?,?,'PENDING','AWAITING_VERDICT',?)")
  .bind(key,c.run_id,c.symbol,c.bar_time,AI_MODEL,new Date(now).toISOString()).run();
 const retry=claimed.meta.changes?null:await env.DB.prepare("UPDATE bist_ai_decisions SET status='PENDING',reason='RETRY_AFTER_FETCH_FIX',attempts=attempts+1 WHERE signal_key=? AND status='ERROR' AND (reason='OPENAI_NETWORK_OR_INVALID_RESPONSE' OR reason LIKE 'OPENAI_FETCH_TYPE_ERROR%') AND attempts<4 RETURNING signal_key").bind(key).first();
 if(claimed.meta.changes||retry){
  let status='ERROR',reason='AI_UNAVAILABLE',input=0,output=0,confidence=null;
  try{
   const risk=await env.DB.prepare('SELECT * FROM bist_funnel_risk WHERE symbol=? AND eligible=1 AND valid_until>?').bind(c.symbol,new Date(now).toISOString()).first();
   if(!risk)throw Error('RESTRICTIONS_EXPIRED');
   const verdict=await aiVerdict(env,c,risk,network);status=verdict.onay?'APPROVED':'REJECTED';reason=verdict.neden;input=verdict.input_tokens;output=verdict.output_tokens;confidence=verdict.guven;
  }catch(e){reason=/^(OPENAI_[A-Z_0-9]+|AI_INPUT_NOT_ELIGIBLE|RESTRICTIONS_EXPIRED)(: .{0,180})?$/.test(e.message)?e.message:'OPENAI_NETWORK_OR_INVALID_RESPONSE';}
  await env.DB.prepare("UPDATE bist_ai_decisions SET status=?,reason=?,completed_at=?,input_tokens=?,output_tokens=?,confidence=? WHERE signal_key=? AND status='PENDING'")
   .bind(status,reason,new Date(now+Math.max(0,Date.now()-wallStart)).toISOString(),input,output,confidence,key).run();
  console.log(JSON.stringify({event:'BIST_AI_DECISION',symbol:c.symbol,status,model:AI_MODEL}));
 }
 return await env.DB.prepare('SELECT * FROM bist_ai_decisions WHERE signal_key=?').bind(key).first();
}
export async function finalize(request,env,now=Date.now(),network=(...args)=>globalThis.fetch(...args)) {
 const b=await readBody(request);if(!validRunId(b.run_id))return json({error:'INVALID_RUN'},422);
 if(!env.OPENAI_API_KEY)return json({error:'OPENAI_KEY_MISSING',signals_created:0},503);
 const rows=await env.DB.prepare(`SELECT c.* FROM bist_funnel_candidates c JOIN bist_funnel_risk r ON r.symbol=c.symbol
  WHERE c.run_id=? AND r.eligible=1 AND r.valid_until>? AND c.bar_time>=?
  ORDER BY c.score DESC,c.symbol ASC`).bind(b.run_id,new Date(now).toISOString(),new Date(now-50*60000).toISOString()).all();
 // No candidate-count cap: five concurrent calls are transport throttling only.
 const candidates=[];
 for(const c of rows.results||[]){const m=JSON.parse(c.metrics_json);if(fresh({bar_time:c.bar_time,feed_type:'INDICATIVE_INTRADAY'},now)&&Number.isFinite(m.daily_turnover_tl_estimate)&&m.daily_turnover_tl_estimate>=MIN_DAILY_TURNOVER_TL&&await env.DB.prepare("SELECT signal_key FROM bist_gemini_decisions WHERE signal_key=? AND status='APPROVED' AND model=?").bind(c.symbol+':'+c.bar_time,GEMINI_MODEL).first())candidates.push(c);}
 const decisions=new Array(candidates.length);let cursor=0;
 await Promise.all(Array.from({length:Math.min(5,candidates.length)},async()=>{
  while(cursor<candidates.length){const index=cursor++;decisions[index]=await judgeCandidate(env,candidates[index],now,network);}
 }));
 let created=0;const selected=[];
 for(let i=0;i<candidates.length;i++){
  const c=candidates[i],decision=decisions[i];if(decision?.status!=='APPROVED')continue;
  // After a slow API response, recheck freshness/risk. Never use request-start time for entry.
  const observed=Math.max(now,Date.parse(decision.completed_at)||now);
  if(!entryWindow(observed)||!fresh({bar_time:c.bar_time,feed_type:'INDICATIVE_INTRADAY'},observed)||!await restrictionClear(env.DB,c.symbol,observed))continue;
  const result=await env.DB.prepare("INSERT OR IGNORE INTO bist_feed_signals(signal_key,symbol,bar_time,observed_at,expires_at,source,metrics_json) VALUES(?,?,?,?,?,'YAHOO_INDICATIVE',?)")
   .bind(decision.signal_key,c.symbol,c.bar_time,new Date(observed).toISOString(),new Date(observed+15*60000).toISOString(),c.metrics_json).run();created+=result.meta.changes;selected.push(c.symbol);
  await enqueueScalp(env.DB,c,decision,observed);
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
 return {status:scanning?'ACTIVE':'BLOCKED_MARKET_DATA_UNAVAILABLE',scanner_live:scanning,time_zone:'Europe/Istanbul',timestamps:'UTC_ISO8601',server_time:new Date(now).toISOString(),data_session_open:sessionOpen(now),freshness_minutes:35,min_daily_turnover_tl:MIN_DAILY_TURNOVER_TL,
  active_symbols:active.length,scanned_symbols:valid.reduce((n,x)=>n+x.fetched,0),
  universe_total:scan[0]?.universe_total||0,eligible_total:scan[0]?.eligible_total||0,
  stage1_hot:scan.reduce((n,x)=>n+x.hot,0),shards_completed:scan.length,
  last_scan_id:scan[0]?.run_id||null,
  last_scan_at:scan.map(x=>x.completed_at).sort().at(-1)||null,
  last_scan_bar:scan.map(x=>x.last_bar_time).filter(Boolean).sort().at(-1)||null,
  last_scan_fetched:scan.reduce((n,x)=>n+x.fetched,0),
  source:'GITHUB_ACTIONS_CLOUD_BRIDGE',market_feed_verified:false,paper_only:true,risk_verified:false,
  last_received:[...(rows.results||[]).map(x=>x.received_at),...scan.map(x=>x.completed_at)].sort().at(-1)||null};
}

export async function externalAudit(request,env,now=Date.now()) {
 const b=await readBody(request),r=b.report;
 if(b.trt_date!==trtDate(now)||!['COMPLETED','MISSING_KEY'].includes(b.status)||!/^gemini-[a-zA-Z0-9.-]+$/.test(b.model)||!r||typeof r.summary!=='string'||r.summary.length>5000||!['issues','calibration'].every(k=>Array.isArray(r[k])&&r[k].length<=100&&r[k].every(x=>typeof x==='string'&&x.length<=2000)))return json({error:'INVALID_EXTERNAL_AUDIT'},422);
 await env.DB.prepare('INSERT INTO bist_external_audits(trt_date,received_at,model,status,report_json) VALUES(?,?,?,?,?) ON CONFLICT(trt_date) DO UPDATE SET received_at=excluded.received_at,model=excluded.model,status=excluded.status,report_json=excluded.report_json').bind(b.trt_date,new Date(now).toISOString(),b.model,b.status,JSON.stringify(r)).run();return json({ok:true});
}
export async function probeMini(env,now=Date.now()) {
 const rows=await env.DB.prepare(`SELECT c.* FROM bist_funnel_candidates c JOIN bist_funnel_risk r ON r.symbol=c.symbol WHERE r.eligible=1 AND r.valid_until>? ORDER BY c.bar_time DESC,c.score DESC`).bind(new Date(now).toISOString()).all();
 const c=(rows.results||[]).find(c=>fresh({bar_time:c.bar_time,feed_type:'INDICATIVE_INTRADAY'},now))||(rows.results||[]).find(c=>trtDate(Date.parse(c.bar_time))===trtDate(now));
 if(!c)return json({status:'NO_FRESH_CANDIDATE',model:AI_MODEL});
 const d=await judgeCandidate(env,c,now,(...args)=>globalThis.fetch(...args));
 return json({purpose:'CONNECTION_CHECK_ONLY',input_fresh:fresh({bar_time:c.bar_time,feed_type:'INDICATIVE_INTRADAY'},now),status:d.status,model:AI_MODEL,symbol:c.symbol,reason:d.reason,confidence:d.confidence});
}

// RFC 8291 payload encryption and RFC 8292 VAPID; no external packages or key logging.
export const pushBytes=s=>new TextEncoder().encode(s);
export function pushB64(b){return btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
export function pushUnb64(s){if(typeof s!=='string'||! /^[A-Za-z0-9_-]+={0,2}$/.test(s))throw Error('INVALID_PUSH_KEY');return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
export function pushJoin(...parts){const out=new Uint8Array(parts.reduce((n,p)=>n+p.byteLength,0));let i=0;for(const p of parts){out.set(new Uint8Array(p),i);i+=p.byteLength;}return out;}
export function pushEndpoint(endpoint){const u=new URL(endpoint);if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!['web.push.apple.com','fcm.googleapis.com','updates.push.services.mozilla.com'].includes(u.hostname))throw Error('INVALID_PUSH_ENDPOINT');return u;}
export async function pushHKDF(secret,salt,info,size){const k=await crypto.subtle.importKey('raw',secret,'HKDF',false,['deriveBits']);return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},k,size*8));}
export async function pushEncrypt(sub,payload){
 const ua=pushUnb64(sub.p256dh),auth=pushUnb64(sub.auth);if(ua.length!==65||ua[0]!==4||auth.length!==16)throw Error('INVALID_PUSH_KEYS');
 const text=pushBytes(JSON.stringify(payload));if(text.length>3000)throw Error('PUSH_PAYLOAD_TOO_LARGE');
 const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
 const pub=new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey));
 const peer=await crypto.subtle.importKey('raw',ua,{name:'ECDH',namedCurve:'P-256'},false,[]);
 const shared=await crypto.subtle.deriveBits({name:'ECDH',public:peer},pair.privateKey,256);
 const ikm=await pushHKDF(shared,auth,pushJoin(pushBytes('WebPush: info\u0000'),ua,pub),32),salt=crypto.getRandomValues(new Uint8Array(16));
 const cek=await pushHKDF(ikm,salt,pushBytes('Content-Encoding: aes128gcm\u0000'),16),nonce=await pushHKDF(ikm,salt,pushBytes('Content-Encoding: nonce\u0000'),12);
 const key=await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['encrypt']);
 const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},key,pushJoin(text,Uint8Array.of(2)));
 const rs=new Uint8Array(4);new DataView(rs.buffer).setUint32(0,4096);
 return pushJoin(salt,rs,Uint8Array.of(pub.length),pub,encrypted);
}
export async function pushAuthorization(env,endpoint,now=Date.now()){
 const aud=pushEndpoint(endpoint).origin,jwk=JSON.parse(env.VAPID_PRIVATE_JWK);
 const header=pushB64(pushBytes(JSON.stringify({typ:'JWT',alg:'ES256'})));
 const claims=pushB64(pushBytes(JSON.stringify({aud,exp:Math.floor(now/1000)+3600,sub:'https://ai-evi.baykatemizlik.workers.dev'})));
 const key=await crypto.subtle.importKey('jwk',jwk,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
 const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,pushBytes(header+'.'+claims));
 return 'vapid t='+header+'.'+claims+'.'+pushB64(signature)+', k='+env.VAPID_PUBLIC_KEY;
}
export async function sendWebPush(env,sub,payload,network=(...args)=>globalThis.fetch(...args)){
 pushEndpoint(sub.endpoint);
 const body=await pushEncrypt(sub,payload),authorization=await pushAuthorization(env,sub.endpoint);
 const response=await network(sub.endpoint,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{Authorization:authorization,TTL:'300',Urgency:'normal','Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream'},body});
 const status=response.status;await response.body?.cancel();return status;
}
export async function pushStatus(env){const sub=await env.DB.prepare('SELECT COUNT(*) n FROM push_subscriptions').first();const counts=await env.DB.prepare('SELECT status,COUNT(*) n FROM bist_push_deliveries GROUP BY status').all();return {configured:!!(env.VAPID_PUBLIC_KEY&&env.VAPID_PRIVATE_JWK),subscribers:sub.n,deliveries:counts.results||[]};}
export async function pushRoute(request,env){
 const path=new URL(request.url).pathname;
 if(path==='/push/key'&&request.method==='GET')return json({key:env.VAPID_PUBLIC_KEY||null,enabled:!!(env.VAPID_PUBLIC_KEY&&env.VAPID_PRIVATE_JWK)},env.VAPID_PUBLIC_KEY&&env.VAPID_PRIVATE_JWK?200:503);
 if(path==='/push/status'&&request.method==='GET')return json(await pushStatus(env));
 if(!['/push/subscribe','/push/test'].includes(path)||request.method!=='POST')return json({error:'METHOD_NOT_ALLOWED'},405);
 if(!env.VAPID_PUBLIC_KEY||!env.VAPID_PRIVATE_JWK)return json({error:'PUSH_NOT_CONFIGURED'},503);
 let b;try{b=await readBody(request);pushEndpoint(b.endpoint);}catch{return json({error:'INVALID_SUBSCRIPTION'},422);}
 if(path==='/push/subscribe'){
  try{const pub=pushUnb64(b.keys?.p256dh),auth=pushUnb64(b.keys?.auth);if(b.endpoint.length>2000||pub.length!==65||pub[0]!==4||auth.length!==16)throw Error();await crypto.subtle.importKey('raw',pub,{name:'ECDH',namedCurve:'P-256'},false,[]);}catch{return json({error:'INVALID_SUBSCRIPTION_KEYS'},422);}
  await env.DB.prepare('INSERT INTO push_subscriptions(endpoint,p256dh,auth,created_at) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth').bind(b.endpoint,b.keys.p256dh,b.keys.auth,new Date().toISOString()).run();return json({ok:true});
 }
 const sub=await env.DB.prepare('SELECT * FROM push_subscriptions WHERE endpoint=?').bind(b.endpoint).first();if(!sub)return json({error:'SUBSCRIPTION_NOT_FOUND'},404);
 try{const status=await sendWebPush(env,sub,{title:'BIST · Test bildirimi',body:'Bildirim bağlantısı çalışıyor. İşlemler sanaldır.',tag:'bist-test-'+Date.now()});if([404,410].includes(status))await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(sub.endpoint).run();return json({accepted:status>=200&&status<300,provider_status:status},status>=200&&status<300?200:502);}catch{return json({error:'PUSH_SEND_FAILED'},502);}
}
export async function drainPush(env,now=Date.now(),network=(...args)=>globalThis.fetch(...args)){
 if(!env.VAPID_PUBLIC_KEY||!env.VAPID_PRIVATE_JWK)return {sent:0,configured:false};
 const stamp=new Date(now).toISOString();
 await env.DB.prepare("INSERT OR IGNORE INTO bist_push_deliveries(event_id,endpoint,status,attempts,next_attempt) SELECT e.id,s.endpoint,'PENDING',0,? FROM bist_push_events e CROSS JOIN push_subscriptions s WHERE e.created_at>=s.created_at AND e.expires_at>? ").bind(stamp,stamp).run();
 const rows=await env.DB.prepare("SELECT d.*,e.payload_json,s.p256dh,s.auth FROM bist_push_deliveries d JOIN bist_push_events e ON e.id=d.event_id JOIN push_subscriptions s ON s.endpoint=d.endpoint WHERE d.status IN('PENDING','ERROR','SENDING') AND d.attempts<5 AND d.next_attempt<=? AND (d.lease_until IS NULL OR d.lease_until<=?) AND e.expires_at>? ORDER BY e.created_at LIMIT 5").bind(stamp,stamp,stamp).all();let sent=0;
 for(const d of rows.results||[]){
  const lease=new Date(now+90000).toISOString();const claim=await env.DB.prepare("UPDATE bist_push_deliveries SET status='SENDING',attempts=attempts+1,lease_until=? WHERE event_id=? AND endpoint=? AND status IN('PENDING','ERROR','SENDING') AND (lease_until IS NULL OR lease_until<=?)").bind(lease,d.event_id,d.endpoint,stamp).run();if(!claim.meta.changes)continue;
  let status=0;try{status=await sendWebPush(env,d,JSON.parse(d.payload_json),network);}catch{}
  const ok=status>=200&&status<300,dead=[404,410].includes(status);
  await env.DB.prepare('UPDATE bist_push_deliveries SET status=?,provider_status=?,lease_until=NULL,next_attempt=? WHERE event_id=? AND endpoint=?').bind(ok?'SENT':dead?'DEAD':'ERROR',status,new Date(now+Math.min(300000,60000*(d.attempts+1))).toISOString(),d.event_id,d.endpoint).run();
  if(dead)await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(d.endpoint).run();if(ok)sent++;
 }
 return {sent};
}
