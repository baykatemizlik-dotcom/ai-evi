// Market data is ingress-only. The only outbound request is the OpenAI paper referee.
const validSymbol = symbol => typeof symbol==='string' && /^[A-Z0-9]{3,6}$/.test(symbol);
const FRESH_MS = 35 * 60000;
const MIN_DAILY_TURNOVER_TL = 40_000_000;
const GEMINI_MODEL = 'gemini-3.1-flash-lite';
const TRT = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',weekday:'short',hourCycle:'h23'});
function trtParts(now){return Object.fromEntries(TRT.formatToParts(new Date(now)).map(x=>[x.type,x.value]));}
const json = (body, status=200) => new Response(JSON.stringify(body), {
 status, headers: {'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}
});
function sessionOpen(now) {
 const p=trtParts(now),minutes=Number(p.hour)*60+Number(p.minute);
 return !['Sat','Sun'].includes(p.weekday) && minutes>=600 && minutes<=1085; // 18:05 TRT
}
function fresh(row, now) {
 const end = Date.parse(row.bar_time || row.time)+900000;
 return row.feed_type==='INDICATIVE_INTRADAY' && (end-900000)%900000===0 && end<=now && now-end<=FRESH_MS && sessionOpen(now);
}
function validate(data, now=Date.now()) {
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
function entryPlan(cash, price) {
 const executed=price*1.002, qty=Math.floor(Math.min(1250,cash)/(executed*1.002));
 return {qty,executed,commission:executed*qty*.002};
}
function exitPlan(trade, bars) {
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
function stageOneMetrics(bars) {
 if(bars.length<21)return null;
 const b=bars.at(-1),prev=bars.slice(-21,-1);
 const avg=prev.reduce((sum,x)=>sum+x.volume,0)/20,spread=b.high-b.low+1e-9;
 const rvol=avg>0?b.volume/avg:0,body=Math.abs(b.close-b.open)/spread,upper_wick=(b.high-b.close)/spread;
 const daily_turnover_tl_estimate=dailyTurnover(bars);
 return rvol>=2 && b.close>b.open && body>=.60 && upper_wick<=.20 && daily_turnover_tl_estimate>=MIN_DAILY_TURNOVER_TL ? {rvol,body,upper_wick,daily_turnover_tl_estimate,turnover_source:'CLOSED_SESSION_CLOSE_X_VOLUME'}:null;
}
function sameSession(bars){const last=bars.at(-1);if(!last)return [];const date=trtDate(Date.parse(last.bar_time||last.time));return bars.filter(b=>{const t=Date.parse(b.bar_time||b.time),p=trtParts(t),minute=Number(p.hour)*60+Number(p.minute);return t<=Date.parse(last.bar_time||last.time)&&trtDate(t)===date&&minute>=600&&minute<1085;});}
function dailyTurnover(bars){return sameSession(bars).reduce((sum,b)=>sum+b.close*b.volume,0);}
function technicalSignal(bars) {
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
async function restrictionClear(db,symbol,now) {
 return !!await db.prepare('SELECT symbol FROM bist_funnel_risk WHERE symbol=? AND eligible=1 AND valid_until>?')
  .bind(symbol,new Date(now).toISOString()).first();
}
function eligibleEntryBar(signal, bars) {
 const earliest = Math.max(Date.parse(signal.bar_time)+900000, Date.parse(signal.observed_at));
 const expiry = Date.parse(signal.expires_at);
 if(!Number.isFinite(earliest)||!Number.isFinite(expiry))return null;
 return bars.find(b=>{const t=Date.parse(b.bar_time);return t%900000===0 && t>=earliest && t<=expiry;})||null;
}
async function runPaper(db,symbol,now){return (await tickStrategies(db,now)).scalp;}
async function runSniper(db,now){return (await tickStrategies(db,now)).trend;}
function entryWindow(now){const p=trtParts(now);return sessionOpen(now)&&Number(p.hour)*60+Number(p.minute)<1060;}
function trtDate(now){const p=trtParts(now);return `${p.year}-${p.month}-${p.day}`;}
async function symbolBars(db,symbol,now=Date.now()){
 // Keep ALL persisted intervening bars from the earliest open position, not only the latest 100.
 const rows=await db.prepare(`SELECT * FROM bist_bridge_bars WHERE symbol=? AND interval='15m' AND source='YAHOO_INDICATIVE'
 AND CAST(strftime('%s',bar_time) AS INTEGER)%900=0 AND julianday(bar_time)+15.0/1440<=julianday(?)
 AND bar_time>=MIN(?,COALESCE((SELECT MIN(entry_time) FROM virtual_trades WHERE symbol=? AND status='OPEN'),?)) ORDER BY bar_time`)
 .bind(symbol,new Date(now).toISOString(),new Date(now-7*86400000).toISOString(),symbol,new Date(now-7*86400000).toISOString()).all();return rows.results||[];
}
async function closePaper(db,trade,exit,now=Date.now()){
 const r=await db.batch([db.prepare("UPDATE virtual_trades SET status='CLOSED',exit_price=?,exit_time=?,pnl_net=?,exit_reason=? WHERE id=? AND status='OPEN'").bind(exit.executed,exit.time,exit.pnl,exit.reason,trade.id),
 db.prepare(`INSERT OR IGNORE INTO bist_exit_audit(trade_id,exit_bar_time,exit_observed_at,exit_reason) SELECT id,?,?,? FROM virtual_trades WHERE id=? AND status='CLOSED' AND exit_time=? AND exit_reason=?`).bind(exit.quote_time||null,new Date(now).toISOString(),exit.reason,trade.id,exit.time,exit.reason)]);
 return r[0].meta.changes>0;
}
async function entryApproved(db,key,bars,now){
 if(dailyTurnover(bars)<MIN_DAILY_TURNOVER_TL)return false;
 return !!await db.prepare("SELECT signal_key FROM bist_gemini_decisions WHERE signal_key=? AND status='APPROVED' AND model=? AND completed_at<=?").bind(key,GEMINI_MODEL,new Date(now).toISOString()).first();
}
async function enforceSessionClose(db,now=Date.now()){
 const result=await tickStrategies(db,now);
 const p=trtParts(now);if(Number(p.hour)*60+Number(p.minute)>=1085)await dailyReport(db,now);
 return result;
}
async function dailyReport(db,now=Date.now()){
 const date=trtDate(now),start=date+'T00:00:00',end=date+'T23:59:59';
 const [trades,ai,cash,queue]=await Promise.all([
  db.prepare("SELECT strategy,COUNT(*) exits,SUM(pnl_net) pnl,SUM(CASE WHEN pnl_net>0 THEN 1 ELSE 0 END) wins FROM strategy_exit_legs WHERE datetime(exit_time,'+3 hours') BETWEEN ? AND ? GROUP BY strategy").bind(start.replace('T',' '),end.replace('T',' ')).all(),
  db.prepare("SELECT status,COUNT(*) n,SUM(input_tokens) input_tokens,SUM(output_tokens) output_tokens FROM bist_ai_decisions WHERE substr(datetime(created_at,'+3 hours'),1,10)=? GROUP BY status").bind(date).all(),
  db.prepare('SELECT strategy,available_cash FROM paper_cash_accounts').all(),db.prepare("SELECT 'SCALP' strategy,status,COUNT(*) n FROM scalp_sniper_queue GROUP BY status UNION ALL SELECT 'SWING',status,COUNT(*) n FROM trend_radar_queue GROUP BY status").all()]);
 const report={trt_date:date,generated_at:new Date(now).toISOString(),paper_only:true,trades:trades.results,ai:ai.results,cash:cash.results,standby:queue.results};
 await db.prepare('INSERT INTO bist_daily_reports(trt_date,generated_at,report_json) VALUES(?,?,?) ON CONFLICT(trt_date) DO UPDATE SET generated_at=excluded.generated_at,report_json=excluded.report_json').bind(date,report.generated_at,JSON.stringify(report)).run();return report;
}

async function readBody(request) {
 if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw Error('JSON_REQUIRED');
 const reader=request.body?.getReader();if(!reader)throw Error('EMPTY_BODY');
 let size=0,chunks=[];
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
  if(size>100000){await reader.cancel();throw Error('PAYLOAD_TOO_LARGE');}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 return JSON.parse(new TextDecoder().decode(bytes));
}
async function ingest(request, env, now=Date.now()) {
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
const validRunId = id => typeof id==='string' && /^[A-Za-z0-9:_-]{1,80}$/.test(id);
async function riskIngest(request,env,now=Date.now()) {
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
async function monitorSymbols(env,now=Date.now()){return json(await strategyMonitor(env.DB,now));}
async function reportIngest(request,env,now=Date.now()) {
 const b=await readBody(request),fields=['shard','universe_total','eligible_total','assigned','fetched','hot','posted','errors'];
 if(!validRunId(b.run_id)||!fields.every(k=>Number.isInteger(b[k])&&b[k]>=0)||b.shard>7||
  b.fetched>b.assigned||b.eligible_total>b.universe_total||b.hot>b.fetched||b.posted>b.hot ||
  (b.last_bar_time!==null&&(!Number.isFinite(Date.parse(b.last_bar_time))||Date.parse(b.last_bar_time)%900000!==0||Date.parse(b.last_bar_time)+900000>now)))
  return json({error:'INVALID_SCAN_REPORT'},422);
 await env.DB.prepare(`INSERT INTO bist_funnel_reports(run_id,shard,universe_total,eligible_total,assigned,fetched,hot,posted,errors,last_bar_time,completed_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,shard) DO UPDATE SET fetched=excluded.fetched,hot=excluded.hot,posted=excluded.posted,errors=excluded.errors,last_bar_time=excluded.last_bar_time,completed_at=excluded.completed_at`)
  .bind(b.run_id,...fields.map(k=>b[k]),b.last_bar_time,new Date(now).toISOString()).run();return json({ok:true});
}
const AI_MODEL='gpt-4o-mini';
async function geminiDecision(request,env,now=Date.now()){
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
async function geminiStatus(env){
 const last=await env.DB.prepare('SELECT symbol,status,reason,model,completed_at FROM bist_gemini_decisions ORDER BY completed_at DESC LIMIT 1').first();
 return {model:GEMINI_MODEL,execution:'GITHUB_ACTIONS',connection:last?last.status==='ERROR'?'ERROR':'CONNECTED':'AWAITING_CLOUD_PROBE',last_decision:last||null};
}
async function aiVerdict(env,candidate,risk,network=(...args)=>globalThis.fetch(...args)) {
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
async function judgeCandidate(env,c,now,network) {
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
async function finalize(request,env,now=Date.now(),network=(...args)=>globalThis.fetch(...args)) {
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
async function aiStatus(env) {
 const last=await env.DB.prepare("SELECT symbol,status,reason,completed_at FROM bist_ai_decisions WHERE status!='PENDING' ORDER BY completed_at DESC LIMIT 1").first();
 return {model:AI_MODEL,connection:!env.OPENAI_API_KEY?'MISSING_KEY':last&&['APPROVED','REJECTED'].includes(last.status)?'CONNECTED':last?.status==='ERROR'?'ERROR':'CONFIGURED',last_decision:last||null};
}
async function feedStatus(db,now=Date.now()) {
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

async function externalAudit(request,env,now=Date.now()) {
 const b=await readBody(request),r=b.report;
 if(b.trt_date!==trtDate(now)||!['COMPLETED','MISSING_KEY'].includes(b.status)||!/^gemini-[a-zA-Z0-9.-]+$/.test(b.model)||!r||typeof r.summary!=='string'||r.summary.length>5000||!['issues','calibration'].every(k=>Array.isArray(r[k])&&r[k].length<=100&&r[k].every(x=>typeof x==='string'&&x.length<=2000)))return json({error:'INVALID_EXTERNAL_AUDIT'},422);
 await env.DB.prepare('INSERT INTO bist_external_audits(trt_date,received_at,model,status,report_json) VALUES(?,?,?,?,?) ON CONFLICT(trt_date) DO UPDATE SET received_at=excluded.received_at,model=excluded.model,status=excluded.status,report_json=excluded.report_json').bind(b.trt_date,new Date(now).toISOString(),b.model,b.status,JSON.stringify(r)).run();return json({ok:true});
}
async function probeMini(env,now=Date.now()) {
 const rows=await env.DB.prepare(`SELECT c.* FROM bist_funnel_candidates c JOIN bist_funnel_risk r ON r.symbol=c.symbol WHERE r.eligible=1 AND r.valid_until>? ORDER BY c.bar_time DESC,c.score DESC`).bind(new Date(now).toISOString()).all();
 const c=(rows.results||[]).find(c=>fresh({bar_time:c.bar_time,feed_type:'INDICATIVE_INTRADAY'},now))||(rows.results||[]).find(c=>trtDate(Date.parse(c.bar_time))===trtDate(now));
 if(!c)return json({status:'NO_FRESH_CANDIDATE',model:AI_MODEL});
 const d=await judgeCandidate(env,c,now,(...args)=>globalThis.fetch(...args));
 return json({purpose:'CONNECTION_CHECK_ONLY',input_fresh:fresh({bar_time:c.bar_time,feed_type:'INDICATIVE_INTRADAY'},now),status:d.status,model:AI_MODEL,symbol:c.symbol,reason:d.reason,confidence:d.confidence});
}

// RFC 8291 payload encryption and RFC 8292 VAPID; no external packages or key logging.
const pushBytes=s=>new TextEncoder().encode(s);
function pushB64(b){return btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function pushUnb64(s){if(typeof s!=='string'||! /^[A-Za-z0-9_-]+={0,2}$/.test(s))throw Error('INVALID_PUSH_KEY');return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
function pushJoin(...parts){const out=new Uint8Array(parts.reduce((n,p)=>n+p.byteLength,0));let i=0;for(const p of parts){out.set(new Uint8Array(p),i);i+=p.byteLength;}return out;}
function pushEndpoint(endpoint){const u=new URL(endpoint);if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!['web.push.apple.com','fcm.googleapis.com','updates.push.services.mozilla.com'].includes(u.hostname))throw Error('INVALID_PUSH_ENDPOINT');return u;}
async function pushHKDF(secret,salt,info,size){const k=await crypto.subtle.importKey('raw',secret,'HKDF',false,['deriveBits']);return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},k,size*8));}
async function pushEncrypt(sub,payload){
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
async function pushAuthorization(env,endpoint,now=Date.now()){
 const aud=pushEndpoint(endpoint).origin,jwk=JSON.parse(env.VAPID_PRIVATE_JWK);
 const header=pushB64(pushBytes(JSON.stringify({typ:'JWT',alg:'ES256'})));
 const claims=pushB64(pushBytes(JSON.stringify({aud,exp:Math.floor(now/1000)+3600,sub:'https://ai-evi.baykatemizlik.workers.dev'})));
 const key=await crypto.subtle.importKey('jwk',jwk,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
 const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,pushBytes(header+'.'+claims));
 return 'vapid t='+header+'.'+claims+'.'+pushB64(signature)+', k='+env.VAPID_PUBLIC_KEY;
}
async function sendWebPush(env,sub,payload,network=(...args)=>globalThis.fetch(...args)){
 pushEndpoint(sub.endpoint);
 const body=await pushEncrypt(sub,payload),authorization=await pushAuthorization(env,sub.endpoint);
 const response=await network(sub.endpoint,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{Authorization:authorization,TTL:'300',Urgency:'normal','Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream'},body});
 const status=response.status;await response.body?.cancel();return status;
}
async function pushStatus(env){const sub=await env.DB.prepare('SELECT COUNT(*) n FROM push_subscriptions').first();const counts=await env.DB.prepare('SELECT status,COUNT(*) n FROM bist_push_deliveries GROUP BY status').all();return {configured:!!(env.VAPID_PUBLIC_KEY&&env.VAPID_PRIVATE_JWK),subscribers:sub.n,deliveries:counts.results||[]};}
async function pushRoute(request,env){
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
async function drainPush(env,now=Date.now(),network=(...args)=>globalThis.fetch(...args)){
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

const iso=n=>new Date(n).toISOString();
const QUEUES={SCALP:'scalp_sniper_queue',SWING:'trend_radar_queue'};
function strategyEntryWindow(strategy,now){const p=trtParts(now),m=+p.hour*60+ +p.minute;return sessionOpen(now)&&m<(strategy==='SCALP'?1060:1080);}
function usableQuote(q,now){return !!q&&q.source==='YAHOO_INDICATIVE'&&Number.isFinite(q.price)&&q.price>0&&Date.parse(q.quote_time)<=now&&now-Date.parse(q.quote_time)<=1200000&&trtDate(Date.parse(q.quote_time))===trtDate(now)&&sessionOpen(now);}
async function saveQuote(db,symbol,q,now){
 if(!validSymbol(symbol)||!q||q.symbol!==symbol||!usableQuote(q,now))return false;
 await db.prepare(`INSERT INTO strategy_quotes(symbol,price,quote_time,received_at,source) VALUES(?,?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET price=excluded.price,quote_time=excluded.quote_time,received_at=excluded.received_at WHERE excluded.quote_time>=strategy_quotes.quote_time`).bind(symbol,q.price,q.quote_time,iso(now),q.source).run();return true;
}
function ema(values,period=200){if(values.length<period)return null;let e=values.slice(0,period).reduce((a,b)=>a+b,0)/period;for(const p of values.slice(period))e=p*2/(period+1)+e*(1-2/(period+1));return e;}
function superTrend(bars,period=10,multiplier=3){
 if(bars.length<period+1)return null;let atr=0,upper=0,lower=0,green=true;
 for(let i=1;i<bars.length;i++){const b=bars[i],prev=bars[i-1],tr=Math.max(b.high-b.low,Math.abs(b.high-prev.close),Math.abs(b.low-prev.close));
  if(i<=period)atr+=tr/period;else atr=(atr*(period-1)+tr)/period;
  if(i<period)continue;
  const bu=(b.high+b.low)/2+multiplier*atr,bl=(b.high+b.low)/2-multiplier*atr;
  if(i===period){upper=bu;lower=bl;green=b.close>=(b.high+b.low)/2;continue;}
  upper=bu<upper||prev.close>upper?bu:upper;lower=bl>lower||prev.close<lower?bl:lower;
  if(green&&b.close<lower)green=false;else if(!green&&b.close>upper)green=true;
 }
 return {green,stop:green?lower:upper,atr};
}
function trendSignal(hour,daily,intraday,now){
 const h=hour.at(-1),d=daily.at(-1);if(!h||!d||hour.length<200||daily.length<200||now-(Date.parse(h.bar_time)+3600000)>90*60000||Date.parse(h.bar_time)+3600000>now||now-Date.parse(d.bar_time)>5*86400000)return null;
 const eh=ema(hour.map(x=>x.close)),ed=ema(daily.map(x=>x.close)),sh=superTrend(hour),sd=superTrend(daily);
 const session=intraday.filter(b=>trtDate(Date.parse(b.bar_time))===trtDate(now)),volume=session.reduce((s,b)=>s+b.volume,0),vwap=volume?session.reduce((s,b)=>s+(b.high+b.low+b.close)/3*b.volume,0)/volume:null;
 if(!eh||!ed||!sh?.green||!sd?.green||!vwap||h.close<=eh||d.close<=ed||h.close<=vwap||sh.stop<=0||sh.stop>=h.close)return null;
 return {ema200_hour:eh,ema200_daily:ed,supertrend_hour:sh,supertrend_daily:sd,vwap,initial_stop:sh.stop,score:100*(h.close/eh-1)+100*(d.close/ed-1),bar_time:h.bar_time};
}
function strategyThresholds(t){const unit=t.executed_price+t.commission/t.lot_count;return {breakeven:unit/(.998*.998),tp:unit*(t.strategy==='SCALP'?1.03:1.04)/(.998*.998),sl:unit*.985/(.998*.998)};}
async function sellLeg(db,t,qty,raw,reason,quoteTime,now,activationTime=null){
 if(!Number.isInteger(qty)||qty<=0||!Number.isFinite(raw)||raw<=0)return false;
 const price=raw*.998,fee=price*qty*.002,pnl=price*qty-fee-(t.executed_price+t.commission/t.lot_count)*qty;
 const key=t.id+':'+(reason==='TREND_TP1'?'TP1':reason==='SCALP_TP1'?'SCALP_TP1':'FINAL');
 const r=await db.prepare(`INSERT OR IGNORE INTO strategy_exit_legs(event_key,trade_id,strategy,symbol,qty,executed_price,commission,exit_time,quote_time,observed_at,reason,pnl_net,activation_time) SELECT ?,id,strategy,symbol,?,?,?,?,?,?,?,?,? FROM virtual_trades WHERE id=? AND status='OPEN' AND remaining_lots=? AND tp1_done=?`).bind(key,qty,price,fee,iso(now),quoteTime,iso(now),reason,pnl,activationTime,t.id,t.remaining_lots,t.tp1_done).run();return r.meta.changes>0;
}
function scalpExit(t,bars,q,now){
 const levels=strategyThresholds(t),entry=Date.parse(t.entry_time),eod=Date.parse(trtDate(entry)+'T14:40:00.000Z');
 const runner=!!t.tp1_done,active=runner?Date.parse(t.scalp_runner_started_at):entry,deadline=entry+3600000,cutoff=runner?eod:Math.min(deadline,eod);let last=null;
 if(!Number.isFinite(active))return null; // Never retroactively infer runner activation.
 const stop=runner?levels.breakeven:levels.sl,stopReason=runner?'SCALP_RUNNER_BE':'SL_NET_1_5';
 const tp=(raw,time,activation)=>({raw,reason:t.lot_count>=2?'SCALP_TP1':'TP_NET_3',time,activation,qty:t.lot_count>=2?Math.floor(t.lot_count*.7):t.remaining_lots});
 for(const b of [...bars].sort((a,b)=>a.bar_time.localeCompare(b.bar_time))){const start=Date.parse(b.bar_time),end=start+900000;if(start<active||end>now||end>cutoff)continue;last=b;
  if(b.low<=stop)return {raw:Math.min(b.open,stop),reason:stopReason,time:b.bar_time};
  if(!runner&&b.high>=levels.tp)return tp(levels.tp,b.bar_time,iso(end));
 }
 const quoteValid=usableQuote(q,now)&&Date.parse(q.quote_time)>=active;
 if(quoteValid&&Date.parse(q.quote_time)<=cutoff){
  if(q.price<=stop)return {raw:q.price,reason:stopReason,time:q.quote_time};
  if(!runner&&q.price>=levels.tp)return tp(q.price,q.quote_time,q.quote_time);
 }
 if(now>=cutoff){const reason=runner?'SCALP_RUNNER_EOD':eod<=deadline?'SCALP_EOD_1740':'TIME_EXIT';
  if(quoteValid&&Date.parse(q.quote_time)>=cutoff)return {raw:q.price,reason,time:q.quote_time};
  if(last&&Date.parse(last.bar_time)+900000>=cutoff&&now-(Date.parse(last.bar_time)+900000)<=900000)return {raw:last.close,reason,time:last.bar_time};
 }return null;
}
async function manageScalp(db,now){const rows=await db.prepare("SELECT * FROM virtual_trades WHERE strategy='SCALP' AND status='OPEN' AND engine_version=2").all();let closed=0,partial=0;
 for(let t of rows.results||[]){const q=await db.prepare('SELECT * FROM strategy_quotes WHERE symbol=?').bind(t.symbol).first(),bars=await symbolBars(db,t.symbol,now);
  // A historical TP1 and a later runner exit may be observed in one monitor tick.
  for(let step=0;step<2;step++){const exit=scalpExit(t,bars,q,now);if(!exit||!await sellLeg(db,t,exit.qty??t.remaining_lots,exit.raw,exit.reason,exit.time,now,exit.activation||null))break;
   if(exit.reason!=='SCALP_TP1'){closed++;break;}partial++;t=await db.prepare('SELECT * FROM virtual_trades WHERE id=?').bind(t.id).first();
  }
 }return {closed,partial};
}
async function trendHistories(db,symbol,now){const r=await db.prepare('SELECT * FROM trend_bars WHERE symbol=? AND bar_time<=? ORDER BY bar_time').bind(symbol,iso(now)).all();return {hour:(r.results||[]).filter(b=>b.interval==='60m'&&Date.parse(b.bar_time)+3600000<=now).slice(-350),daily:(r.results||[]).filter(b=>b.interval==='1d'&&trtDate(Date.parse(b.bar_time))<trtDate(now)).slice(-350)};}
async function manageTrend(db,now){const rows=await db.prepare("SELECT * FROM virtual_trades WHERE strategy='SWING' AND status='OPEN' AND engine_version=2").all();let closed=0,partial=0;
 for(let t of rows.results||[]){const {hour,daily}=await trendHistories(db,t.symbol,now),levels=strategyThresholds(t);
  for(const b of hour){if(Date.parse(b.bar_time)<Date.parse(t.entry_time)||t.last_processed_trend_bar&&b.bar_time<=t.last_processed_trend_bar)continue;
   // Stop established at OPEN takes priority; a stop raised by this candle applies later.
   if(t.trailing_stop&&b.low<=t.trailing_stop){if(await sellLeg(db,t,t.remaining_lots,Math.min(b.open,t.trailing_stop),t.tp1_done?'TREND_TRAILING':'TREND_INITIAL_STOP',b.bar_time,now))closed++;break;}
   if(!t.tp1_done&&b.high>=levels.tp){if(await sellLeg(db,t,Math.floor(t.lot_count/2),levels.tp,'TREND_TP1',b.bar_time,now))partial++;t=await db.prepare('SELECT * FROM virtual_trades WHERE id=?').bind(t.id).first();}
   const prior=hour.filter(x=>x.bar_time<=b.bar_time).slice(-2),candidate=t.tp1_done&&prior.length===2?Math.min(...prior.map(x=>x.low)):0;
   const stop=Math.max(t.trailing_stop||0,candidate,t.tp1_done?levels.breakeven:0);
   await db.prepare(`UPDATE virtual_trades SET trailing_stop=MAX(COALESCE(trailing_stop,0),?),last_processed_trend_bar=? WHERE id=? AND status='OPEN' AND (last_processed_trend_bar IS NULL OR last_processed_trend_bar<?)`).bind(stop,b.bar_time,t.id,b.bar_time).run();t=await db.prepare('SELECT * FROM virtual_trades WHERE id=?').bind(t.id).first();
  }
  if(t.status!=='OPEN')continue;
  // Quote must follow the last fully processed candle; never apply a newly raised stop to an older quote.
  const q=await db.prepare('SELECT * FROM strategy_quotes WHERE symbol=?').bind(t.symbol).first();
  if(!usableQuote(q,now)||Date.parse(q.quote_time)<Math.max(Date.parse(t.entry_time),t.last_processed_trend_bar?Date.parse(t.last_processed_trend_bar)+3600000:0))continue;
  if(t.trailing_stop&&q.price<=t.trailing_stop){if(await sellLeg(db,t,t.remaining_lots,q.price,t.tp1_done?'TREND_TRAILING':'TREND_INITIAL_STOP',q.quote_time,now))closed++;continue;}
  if(!t.tp1_done&&q.price>=levels.tp){if(await sellLeg(db,t,Math.floor(t.lot_count/2),q.price,'TREND_TP1',q.quote_time,now))partial++;t=await db.prepare('SELECT * FROM virtual_trades WHERE id=?').bind(t.id).first();}
  const sessions=daily.filter(b=>trtDate(Date.parse(b.bar_time))>=trtDate(Date.parse(t.entry_time))).length;
  if(sessions>=5&&await sellLeg(db,t,t.remaining_lots,q.price,'TREND_MAX_5_SESSIONS',q.quote_time,now))closed++;
 }return {closed,partial};
}
async function fillStrategy(db,strategy,now){const table=QUEUES[strategy];if(!table)throw Error('UNKNOWN_STRATEGY');let opened=0;
 await db.prepare(`UPDATE ${table} SET status='EXPIRED',reason='EXPIRED' WHERE status='READY' AND expires_at<=?`).bind(iso(now)).run();
 if(!strategyEntryWindow(strategy,now))return {opened,blocked:'ENTRY_WINDOW_CLOSED'};
 const qrows=await db.prepare(`SELECT * FROM ${table} WHERE status='READY' AND expires_at>? ORDER BY ${strategy==='SWING'?'priority DESC,':''}score DESC,observed_at ASC,symbol ASC LIMIT 100`).bind(iso(now)).all();
 for(const q of qrows.results||[]){
  const slots=await db.prepare("SELECT slot_id,symbol FROM virtual_trades WHERE strategy=? AND status='OPEN'").bind(strategy).all(),open=slots.results||[],slot=[1,2].find(x=>!open.some(t=>t.slot_id===x));if(!slot)break;if(open.some(t=>t.symbol===q.symbol))continue;
  const quote=await db.prepare('SELECT * FROM strategy_quotes WHERE symbol=?').bind(q.symbol).first();if(!usableQuote(quote,now)||!await restrictionClear(db,q.symbol,now))continue;
  let stop=null;
  if(strategy==='SCALP'){
   const g=await db.prepare("SELECT status FROM bist_gemini_decisions WHERE signal_key=? AND model=?").bind(q.signal_key,GEMINI_MODEL).first(),a=await db.prepare("SELECT status FROM bist_ai_decisions WHERE signal_key=? AND model='gpt-4o-mini'").bind(q.signal_key).first();if(g?.status!=='APPROVED'||a?.status!=='APPROVED')continue;
   // For an already approved scalp, do not require another breakout candle.
   const m=JSON.parse(q.metrics_json);if(quote.price<=m.resistance||quote.price<=m.vwap){await db.prepare(`UPDATE ${table} SET status='INVALID',reason='BREAKOUT_OR_VWAP_LOST' WHERE signal_key=? AND status='READY'`).bind(q.signal_key).run();continue;}
  }else{const {hour,daily}=await trendHistories(db,q.symbol,now),m=trendSignal(hour,daily,await symbolBars(db,q.symbol,now),now);if(!m||quote.price<=m.vwap||quote.price<=m.ema200_hour){await db.prepare(`UPDATE ${table} SET status='INVALID',reason='TREND_RECHECK_FAILED' WHERE signal_key=? AND status='READY'`).bind(q.signal_key).run();continue;}stop=m.initial_stop;if(quote.price<=stop)continue;}
  const account=await db.prepare('SELECT available_cash FROM paper_cash_accounts WHERE strategy=?').bind(strategy).first(),plan=entryPlan(account?.available_cash||0,quote.price);if(plan.qty<2)continue;
  try{const key=(strategy==='SCALP'?'SCALP:':'TREND:')+q.signal_key;const r=await db.prepare(`INSERT INTO virtual_trades(strategy,symbol,signal_price,executed_price,lot_count,commission,entry_time,status,slot_id,feed_entry_key,engine_version,remaining_lots,tp1_done,trailing_stop,entry_quote_time,entry_observed_at) VALUES(?,?,?,?,?,?,?,'OPEN',?,?,2,?,0,?,?,?) ON CONFLICT(feed_entry_key) DO NOTHING`).bind(strategy,q.symbol,quote.price,plan.executed,plan.qty,plan.commission,iso(now),slot,key,plan.qty,stop,quote.quote_time,iso(now)).run();opened+=r.meta.changes;}catch(e){if(!/PAPER_SLOT_BUSY|PAPER_INSUFFICIENT_CASH|PAPER_SIGNAL_NOT_ELIGIBLE|PAPER_QUOTE_OR_RISK_INVALID/.test(String(e)))throw e;}
 }return {opened};
}
async function tickStrategies(db,now=Date.now()){
 const scalp=await manageScalp(db,now),trend=await manageTrend(db,now),scalpFill=await fillStrategy(db,'SCALP',now),trendFill=await fillStrategy(db,'SWING',now);
 return {scalp:{...scalp,...scalpFill},trend:{...trend,...trendFill},paper_only:true};
}
async function enqueueScalp(db,c,decision,observed){
 const stamp=iso(observed),expiry=iso(observed+900000);
 await db.batch([db.prepare("UPDATE scalp_sniper_queue SET status='EXPIRED',reason='SUPERSEDED' WHERE symbol=? AND status='READY' AND signal_key<>?").bind(c.symbol,decision.signal_key),db.prepare(`INSERT OR IGNORE INTO scalp_sniper_queue VALUES(?,?,?,?,?,?,'READY','TWO_AI_APPROVED',?)`).bind(decision.signal_key,c.symbol,c.bar_time,stamp,expiry,c.score,c.metrics_json)]);
 return await fillStrategy(db,'SCALP',observed);
}
async function boundedBody(request){if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw Error('JSON_REQUIRED');const reader=request.body?.getReader();if(!reader)throw Error('EMPTY_BODY');let n=0,s='';const decoder=new TextDecoder();while(true){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>200000){await reader.cancel();throw Error('PAYLOAD_TOO_LARGE');}s+=decoder.decode(value,{stream:true});}return JSON.parse(s+decoder.decode());}
function validateTrendBars(symbol,interval,rows,now){
 if(!validSymbol(symbol)||!['60m','1d'].includes(interval)||!Array.isArray(rows)||!rows.length||rows.length>350)throw Error('INVALID_TREND_BARS');const seen=new Set();
 return rows.map(b=>{const t=Date.parse(b.time),v=[b.open,b.high,b.low,b.close,b.volume];if(typeof b.time!=='string'||!b.time.endsWith('Z')||!Number.isFinite(t)||t>now||t<now-800*86400000||!v.every(x=>typeof x==='number'&&Number.isFinite(x))||Math.min(...v.slice(0,4))<=0||b.volume<0||b.low>Math.min(b.open,b.close)||b.high<Math.max(b.open,b.close)||interval==='60m'&&(![0,1800000].includes(t%3600000)||t+3600000>now)||interval==='1d'&&trtDate(t)>=trtDate(now)||seen.has(t))throw Error('INVALID_TREND_BAR');seen.add(t);return {...b,symbol,interval,time:iso(t)};}).sort((a,b)=>a.time.localeCompare(b.time));
}
async function trendIngest(request,env,now=Date.now()){
 let b,hour,daily;try{b=await boundedBody(request);if(b.source!=='YAHOO_INDICATIVE')throw Error('INVALID_TREND_SOURCE');hour=validateTrendBars(b.symbol,'60m',b.hour,now);daily=validateTrendBars(b.symbol,'1d',b.daily,now);}catch(e){return json({error:e.message},422);}
 const rows=[...hour,...daily];await env.DB.prepare(`INSERT INTO trend_bars SELECT json_extract(value,'$.symbol'),json_extract(value,'$.interval'),json_extract(value,'$.time'),json_extract(value,'$.open'),json_extract(value,'$.high'),json_extract(value,'$.low'),json_extract(value,'$.close'),json_extract(value,'$.volume'),'YAHOO_INDICATIVE',? FROM json_each(?) WHERE true ON CONFLICT(symbol,interval,bar_time) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume,received_at=excluded.received_at`).bind(iso(now),JSON.stringify(rows)).run();
 await saveQuote(env.DB,b.symbol,b.quote,now);
 const m=trendSignal(hour.map(x=>({...x,bar_time:x.time})),daily.map(x=>({...x,bar_time:x.time})),await symbolBars(env.DB,b.symbol,now),now);let queued=0;
 if(m&&strategyEntryWindow('SWING',now)&&await restrictionClear(env.DB,b.symbol,now)){
  const key=b.symbol+':'+m.bar_time,priority=await env.DB.prepare('SELECT priority FROM berker3_symbols WHERE symbol=? AND active=1').bind(b.symbol).first(),expiry=trtDate(now)+'T15:05:00.000Z';
  await env.DB.prepare("UPDATE trend_radar_queue SET status='EXPIRED',reason='SUPERSEDED' WHERE symbol=? AND signal_key<>? AND status='READY'").bind(b.symbol,key).run();
  const r=await env.DB.prepare(`INSERT OR IGNORE INTO trend_radar_queue VALUES(?,?,?,?,?,?,?,'READY','EMA200_SUPERTREND_VWAP',?)`).bind(key,b.symbol,m.bar_time,iso(now),expiry,m.score,priority?.priority||0,JSON.stringify(m)).run();queued=r.meta.changes;
 }
 return json({ok:true,queued,criteria_passed:!!m,engines:await tickStrategies(env.DB,now),paper_only:true});
}
async function strategyMonitor(db,now=Date.now()){
 const r=await db.prepare(`SELECT symbol,strategy FROM virtual_trades WHERE status='OPEN' UNION SELECT symbol,'SCALP' FROM scalp_sniper_queue WHERE status='READY' AND expires_at>? UNION SELECT symbol,'SWING' FROM trend_radar_queue WHERE status='READY' AND expires_at>?`).bind(iso(now),iso(now)).all();const targets=r.results||[];return {symbols:[...new Set(targets.map(x=>x.symbol))],targets};
}
async function manualStrategyClose(request,env,now=Date.now()){
 const b=await boundedBody(request);if(!Number.isInteger(b.trade_id)||!['SCALP','SWING'].includes(b.strategy))return json({error:'INVALID_TRADE'},422);
 const t=await env.DB.prepare("SELECT * FROM virtual_trades WHERE id=? AND strategy=? AND status='OPEN' AND engine_version=2").bind(b.trade_id,b.strategy).first();if(!t)return json({error:'TRADE_NOT_OPEN'},409);
 const q=await env.DB.prepare('SELECT * FROM strategy_quotes WHERE symbol=?').bind(t.symbol).first();if(!usableQuote(q,now)||Date.parse(q.quote_time)<Date.parse(t.entry_time))return json({error:'FRESH_QUOTE_REQUIRED'},409);
 const closed=await sellLeg(env.DB,t,t.remaining_lots,q.price,'MANUAL_CLOSE',q.quote_time,now);
 return json({ok:closed,refill:await fillStrategy(env.DB,t.strategy,now),paper_only:true});
}
async function isolatedOverview(db,now=Date.now()){
 const [status,cash,open,legs,old,scalp,trend]=await Promise.all([feedStatus(db,now),db.prepare('SELECT * FROM paper_cash_accounts').all(),db.prepare(`SELECT t.*,q.price current_price,q.quote_time FROM virtual_trades t LEFT JOIN strategy_quotes q ON q.symbol=t.symbol WHERE t.status='OPEN' ORDER BY t.strategy,t.slot_id`).all(),db.prepare('SELECT * FROM strategy_exit_legs ORDER BY observed_at DESC LIMIT 200').all(),db.prepare("SELECT id, strategy,symbol,lot_count qty,exit_price executed_price,exit_time,exit_reason reason,pnl_net FROM virtual_trades WHERE status='CLOSED' AND engine_version=1 ORDER BY exit_time DESC LIMIT 100").all(),db.prepare("SELECT s.*,q.price indicative_price,q.quote_time FROM scalp_sniper_queue s LEFT JOIN strategy_quotes q ON q.symbol=s.symbol WHERE s.status='READY' AND s.expires_at>? ORDER BY s.score DESC").bind(iso(now)).all(),db.prepare("SELECT * FROM trend_radar_queue WHERE status='READY' AND expires_at>? ORDER BY priority DESC,score DESC").bind(iso(now)).all()]);
 const [ai,watch,counts]=await Promise.all([
 db.prepare("SELECT d.symbol,d.bar_time,d.completed_at,d.confidence,d.reason,COALESCE(q.status,s.status) signal_status,COALESCE(q.expires_at,s.expires_at) expires_at,t.strategy,t.status trade_status,t.executed_price,t.lot_count,t.remaining_lots,t.entry_time,t.exit_time,t.pnl_net FROM bist_ai_decisions d LEFT JOIN scalp_sniper_queue q ON q.signal_key=d.signal_key LEFT JOIN bist_feed_signals s ON s.signal_key=d.signal_key LEFT JOIN virtual_trades t ON t.feed_entry_key=d.signal_key OR t.feed_entry_key='SCALP:'||d.signal_key OR t.feed_entry_key='SNIPER:'||d.signal_key WHERE d.status='APPROVED' AND date(d.completed_at,'+3 hours')=? ORDER BY d.completed_at DESC LIMIT 100").bind(trtDate(now)).all(),
 db.prepare("SELECT c.symbol,'CLOUD_FEED' source,'SCALP' strategy,0 verified,c.observed_at created_at,d.status ai_status,COALESCE(q.status,s.status,'NOT_APPROVED') candidate_status FROM bist_funnel_candidates c LEFT JOIN bist_ai_decisions d ON d.signal_key=c.symbol||':'||c.bar_time LEFT JOIN scalp_sniper_queue q ON q.signal_key=c.symbol||':'||c.bar_time LEFT JOIN bist_feed_signals s ON s.signal_key=c.symbol||':'||c.bar_time WHERE date(c.observed_at,'+3 hours')=date('now','+3 hours') AND c.observed_at=(SELECT MAX(c2.observed_at) FROM bist_funnel_candidates c2 WHERE c2.symbol=c.symbol) ORDER BY c.observed_at DESC,c.score DESC LIMIT 100").all(),
 db.prepare("SELECT count(DISTINCT symbol) approved FROM bist_ai_decisions WHERE status='APPROVED' AND date(completed_at,'+3 hours')=?").bind(trtDate(now)).first()]);
 const accounts=Object.fromEntries((cash.results||[]).map(x=>[x.strategy,x.available_cash])),trades=(open.results||[]).map(t=>{const qty=t.remaining_lots??t.lot_count,unit=t.executed_price+t.commission/t.lot_count,price=t.current_price||t.executed_price;const q={price,quote_time:t.quote_time,source:'YAHOO_INDICATIVE'};return {...t,remaining_lots:qty,current_price:price,quote_fresh:usableQuote(q,now),quote_age_minutes:t.quote_time?Math.max(0,(now-Date.parse(t.quote_time))/60000):null,unrealised_net:price*qty*.998*.998-unit*qty,unrealised_pct:100*(price*.998*.998/unit-1),elapsed_minutes:Math.max(0,(now-Date.parse(t.entry_time))/60000),runner_active: t.strategy==='SCALP'&&!!t.tp1_done,remaining_minutes:Math.max(0,((t.strategy==='SCALP'&&t.tp1_done?Date.parse(trtDate(Date.parse(t.entry_time))+'T14:40:00.000Z'):Date.parse(t.entry_time)+3600000)-now)/60000),thresholds:strategyThresholds(t)};});
 const histories=[...(legs.results||[]),...(old.results||[]).map(t=>({...t,event_key:'legacy:'+t.id,observed_at:t.exit_time}))].sort((a,b)=>String(b.observed_at).localeCompare(String(a.observed_at)));
 const realised=await db.prepare("SELECT (SELECT COALESCE(SUM(pnl_net),0) FROM strategy_exit_legs)+(SELECT COALESCE(SUM(pnl_net),0) FROM virtual_trades WHERE status='CLOSED' AND engine_version=1) pnl").first();
 return {...status,ai_signals:ai.results||[],watchlist:watch.results||[],approved:counts?.approved||0,candidates:status.stage1_hot||0,pending_entries:(scalp.results||[]).length+(trend.results||[]).length,total_capital:5000,equity:(accounts.SCALP||0)+(accounts.SWING||0)+trades.reduce((n,t)=>n+t.current_price*t.remaining_lots*.998*.998,0),equity_basis:'LAST_AVAILABLE_QUOTE_NET_LIQUIDATION_ESTIMATE',realised_pnl:realised?.pnl||0,scalp_cash:accounts.SCALP||0,swing_cash:accounts.SWING||0,open_trades:trades,exit_history:histories,closed_trades:histories,scalp_sniper_queue:scalp.results||[],trend_radar_queue:trend.results||[],scalp_slots:trades.filter(t=>t.strategy==='SCALP').length,trend_slots:trades.filter(t=>t.strategy==='SWING').length,engine_version:2};
}
async function quoteIngest(request,env,now=Date.now()){
 let b;try{b=await boundedBody(request);}catch(e){return json({error:e.message},422);}
 if(!await saveQuote(env.DB,b.symbol,b.quote,now))return json({error:'FRESH_PROVIDER_QUOTE_REQUIRED'},422);
 return json({ok:true,engines:await tickStrategies(env.DB,now)});
}
async function trendUniverse(db,now=Date.now()){const r=await db.prepare(`SELECT symbol FROM bist_universe WHERE active=1 UNION SELECT symbol FROM bist_funnel_risk WHERE eligible=1 AND valid_until>? UNION SELECT symbol FROM berker3_symbols WHERE active=1`).bind(iso(now)).all();const p=await db.prepare('SELECT symbol FROM berker3_symbols WHERE active=1 ORDER BY priority DESC,symbol').all();return json({symbols:(r.results||[]).map(x=>x.symbol),priority:(p.results||[]).map(x=>x.symbol)});}
async function berker3Route(request,env){
 if(request.method==='GET'){const r=await env.DB.prepare('SELECT symbol FROM berker3_symbols WHERE active=1 ORDER BY priority DESC,symbol').all();return json({symbols:(r.results||[]).map(x=>x.symbol)});}
 if(request.method!=='POST')return json({error:'METHOD_NOT_ALLOWED'},405);
 const b=await boundedBody(request);if(!Array.isArray(b.symbols)||b.symbols.length>100||!b.symbols.every(validSymbol)||new Set(b.symbols).size!==b.symbols.length)return json({error:'INVALID_SYMBOLS'},422);
 await env.DB.batch([env.DB.prepare('UPDATE berker3_symbols SET active=0'),...b.symbols.map(symbol=>env.DB.prepare('INSERT INTO berker3_symbols(symbol,priority,active) VALUES(?,1,1) ON CONFLICT(symbol) DO UPDATE SET active=1,priority=1').bind(symbol)),env.DB.prepare('UPDATE trend_radar_queue SET priority=COALESCE((SELECT priority FROM berker3_symbols b WHERE b.symbol=trend_radar_queue.symbol AND b.active=1),0)')]);return json({ok:true,symbols:b.symbols});
}

const reply=json;
const hash=async value=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
const secureEqual=async(a,b)=>{const[x,y]=await Promise.all([hash(a),hash(b)]);let d=0;for(let i=0;i<x.length;i++)d|=x[i]^y[i];return d===0;};
export default {async fetch(request,env){
 const u=new URL(request.url);
 const dashboard=String.raw`<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0b1019"><meta name="referrer" content="no-referrer"><link rel="manifest" href="/manifest.json"><title>BIST AVCI</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0b1019;color:#f2f5fa;font:15px -apple-system,BlinkMacSystemFont,system-ui,sans-serif}main{max-width:720px;margin:auto;padding:20px 17px 100px}header{display:flex;justify-content:space-between;align-items:center;gap:8px}h1{font-size:25px;line-height:1.15;margin:0}h2{font-size:18px;margin:25px 0 12px}p{color:#aeb8c8;margin:5px 0 13px;line-height:1.45}.muted,small{color:#99a5b5;font-size:12px}.badge{border-radius:50px;padding:8px 12px;background:#26313f;color:#ced9e7;font-size:12px}.api{display:flex;gap:7px;flex-wrap:wrap;margin:19px 0}.pill{padding:9px 12px;border:1px solid #374459;border-radius:25px;font-size:12px;color:#ccd5e2;background:#151d2b}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#778394;margin-right:6px}.ok{background:#37d58c;box-shadow:0 0 7px #37d58c}.bad{background:#ff7070}.wait{background:#e6bc50}.panel,.tile{border:1px solid #2d3849;border-radius:17px;padding:17px;background:#151d2b}.hero{background:linear-gradient(125deg,#1c3345,#122332);border:1px solid #365165;border-radius:19px;padding:20px;margin-top:18px}.hero strong{font-size:32px;letter-spacing:-1px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.statgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:12px}.stat{background:#222b3a;border-radius:14px;padding:13px;text-align:center}.stat strong{font-size:23px;display:block}.stat small{font-size:12px}.money{font-size:23px;font-weight:750;margin-top:6px}.empty{padding:18px;border:1px solid #354356;border-radius:15px;color:#a7b5c6;background:#111925;line-height:1.5}.hrow{display:flex;justify-content:space-between;align-items:center;gap:10px}.hrow h2{margin:23px 0 12px}.tabs{display:flex;gap:8px;margin-bottom:12px}.tabs button{width:auto;border-radius:24px;padding:10px 16px;background:#263244}.tabs button.active{background:#32745f}.page{display:none}.page.active{display:block}.nav{position:fixed;z-index:5;bottom:0;left:0;right:0;padding:9px max(10px,env(safe-area-inset-left)) calc(8px + env(safe-area-inset-bottom));background:#111a28;border-top:1px solid #394252;display:flex;justify-content:space-around;gap:4px}.nav button{border:0;background:transparent;flex:1;min-width:0;padding:7px 0;color:#9daabd;font-size:11px;border-radius:10px}.nav button.active{color:#65dfab;background:#213348}.nav b{display:block;font-size:20px;margin-bottom:3px}button{cursor:pointer;border:1px solid #426477;border-radius:11px;padding:12px 14px;background:#226b59;color:white;font-size:14px;font-weight:650}button:disabled{opacity:.6}input{width:100%;background:#0b111c;border:1px solid #56647a;border-radius:11px;padding:14px;color:#fff;font-size:16px;margin:8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0a121e;border-radius:12px;padding:13px;color:#cdd9e7;font-size:12px;max-height:260px;overflow:auto}.warn{color:#e9c782}.subtle{border-top:1px solid #29374a;margin:19px 0 0}.chip{font-size:12px;border:1px solid #45617b;padding:5px 9px;border-radius:20px;color:#aecaee}.cards{display:grid;gap:9px}a{color:#81dccc}@media(min-width:700px){.nav{max-width:720px;margin:auto;border-left:1px solid #394252;border-right:1px solid #394252}}
.room{margin:16px 0}.row{display:flex;align-items:center;justify-content:space-between;gap:8px}.card{background:#151d2b;border:1px solid #2d3849;border-radius:17px;padding:16px;margin:10px 0}.price{font-size:24px;font-weight:750}.gain{color:#65dfab}.loss{color:#ff9191}.kv{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}.kv b{display:block}.queue{padding:12px 0;border-bottom:1px solid #2d3849}.queue button{margin:4px;font-size:12px;padding:9px}.close{width:100%;background:#5c3543}.history{padding:14px 0;border-bottom:1px solid #2d3849}.rule{font-size:12px;color:#99a5b5}.room h3{font-size:16px}section.settings{padding:12px 0}.reserve-grid{margin-top:11px}.reserve-grid button.tile{width:100%;text-align:left;color:#f2f5fa;font:inherit;min-height:110px}.reserve-grid button.tile:focus-visible{outline:2px solid #65dfab;outline-offset:3px}.reserve-grid .money{font-size:21px}.reserve-grid small{display:block;margin-top:6px}#scalpQueueTitle,#trendQueueTitle{scroll-margin-top:18px}</style></head><body><main>
<header><div><h1>📈 BIST AVCI</h1><p>Bulut radar & sanal portföy · teknik demo</p></div><span class="badge" id="mainState">Veri bekleniyor</span></header>
<div class="api"><span class="pill"><i id="geminiDot" class="dot"></i>Gemini · <span id="geminiText">Kontrol bekliyor</span></span><span class="pill"><i id="gptDot" class="dot"></i>GPT · <span id="gptText">Kontrol bekliyor</span></span></div>
<div id="home" class="page active">
<div class="hero" role="button" tabindex="0" data-jump="demo"><small>💼 Sanal portföy · nakit + giriş değeri</small><div><strong id="total">5.000,00 TL</strong></div><p>Gerçekleşen kâr/zarar: <span id="pnl">Henüz işlem yok</span></p></div>
<div class="grid" style="margin-top:11px"><div class="tile" role="button" tabindex="0" data-jump="demo"><b>⚡ SCALP</b><div class="money" id="scalpCash">2.500 TL</div><small>Kullanılabilir nakit · işlemler için dokun</small></div><div class="tile" role="button" tabindex="0" data-jump="candidates"><b>🎯 TREND</b><div class="money" id="swingCash">2.500 TL</div><small>Kullanılabilir nakit · iki slot için dokun</small></div></div>
<div class="grid reserve-grid"><button type="button" class="tile" id="homeScalpReserve" data-queue-target="SCALP"><b>⚡ Scalp Yedekleri</b><div class="money"><span id="homeScalpReserveCount">0</span> yedek</div><small>Scalp kuyruğunu aç →</small></button><button type="button" class="tile" id="homeTrendReserve" data-queue-target="SWING"><b>🎯 Trend Yedekleri</b><div class="money"><span id="homeTrendReserveCount">0</span> yedek</div><small>Trend radarını aç →</small></button></div>
<div class="statgrid"><div class="stat" role="button" tabindex="0" data-jump="radar"><strong id="scanned">0</strong><small>Taranan</small></div><div class="stat" role="button" tabindex="0" data-jump="candidates"><strong id="candidateCount">0</strong><small>Son tarama · sıcak aday</small></div><div class="stat" role="button" tabindex="0" data-jump="signals"><strong id="approved">0</strong><small>Bugün mini onaylı</small></div></div>
<div class="hrow"><h2>🎯 Günün İzleme Listesi</h2><small id="scanTime">Son tarama bekleniyor</small></div><p id="panelFreshness" aria-live="polite" style="font-size:13px;color:#9eafc2">Panel bağlanıyor…</p><p id="feedDetail" aria-live="polite">Veri zamanı bekleniyor.</p><div class="empty" id="watchlist" role="button" tabindex="0" data-jump="candidates">Henüz doğrulanmış piyasa verisiyle liste oluşmadı.</div>
<div class="hrow"><h2>⚡ Canlı Radar</h2><small>15 dakikalık bulut döngüsü</small></div><div class="panel"><div class="hrow"><span>Piyasa veri kaynağı</span><span class="warn" id="marketState">Bağlantı bekleniyor</span></div><div class="hrow" style="margin-top:14px"><span>Son tarama</span><span class="warn" id="xuState">Veri bekleniyor</span></div><p class="muted" id="lastRun" style="margin-top:13px">Son tarama: bekleniyor</p></div>
<div class="hrow"><h2>✅ Onaylı Sinyaller</h2><small>En yeniler üstte</small></div><div class="tabs"><button class="active" data-filter="ALL">Tümü</button><button data-filter="SCALP">Günlük</button><button data-filter="SWING">Trend</button></div><div class="empty" id="signalsHome">Henüz onaylı AL / SAT sinyali yok.</div>
<h2>💼 Açık Demo İşlemler</h2><div class="empty" id="openHome">Henüz sanal işlem açılmadı.</div><h2>📊 Performans</h2><div class="empty" id="performanceHome">Gerçek fiyatlarla kapanan sanal işlemler burada gösterilecek.</div>
</div>
<div id="candidates" class="page"><h2>🎯 Pusudaki Adaylar</h2><div class="tabs"><button class="active" data-candidate-filter="ALL">Tümü</button><button data-candidate-filter="SCALP">⚡ Scalp</button><button data-candidate-filter="SWING">🎯 Trend</button><button data-candidate-filter="WHALE">🐋 Balina</button></div><p>Gerçek kaynaklardan doğrulanan adaylar burada gösterilir. Aday, AL sinyali değildir.</p><div id="candidateList" class="cards"><div class="empty">Henüz aday yok.</div></div><h2>🎯 Trend · 2 Slot</h2><div id="sniperPosition" class="panel">Açık Trend işlemi yok.</div><h2>🪑 Dinamik Yedek Havuz</h2><p>Mini onaylı adaylar güç sırasıyla gösterilir. Bozulan veya bayatlayan aday giriş için kullanılmaz.</p><div id="sniperStandby" class="cards"></div><h2>⚡ SCALP Slotları</h2><div id="scalpSlots" class="cards"></div></div><div id="radar" class="page"><h2>🎯 Radar</h2><p>⚡ Günlük Al-Sat · 📈 Swing · 🐋 Sessiz Balina</p><div class="empty" id="radarState">Doğrulanmış piyasa mum verisi gelmeden otomatik hisse taraması yapılamıyor.</div><h2>Manuel hisse araştırması</h2><div class="panel"><p>Bu bölüm sinyal değildir, mevcut araştırma testidir.</p><input id="symbol" value="ASTOR" maxlength="6" autocapitalize="characters" placeholder="Hisse kodu"><button id="go">Araştır</button><pre id="result">Henüz araştırma yapılmadı.</pre></div></div>
<div id="signals" class="page"><h2>✅ Onaylı Sinyaller</h2><div class="empty" id="signalsPage">Teknik filtre ve resmî risk teyidinden geçmiş sinyal henüz bulunmuyor.</div><p>Mini onayı sanal giriş kararıdır; gerçekleşmiş alım değildir. Ayrıntılar için karta dokun.</p></div>
<div id="demo" class="page"><h2>💼 Demo Portföy</h2><div class="hero" role="button" tabindex="0" data-jump="demo"><small>Başlangıç sanal kasa</small><div><strong id="demoTotal">5.000,00 TL</strong></div><p>SCALP ve TREND kasaları ayrı tutulur. Gerçek banka emri verilmez.</p></div><div class="rooms"><section class="room" id="scalpRoom"><div class="row"><h2>⚡ SCALP ODASI</h2><span class="badge">15 dakika</span></div><p class="rule">Net +%3’te %70 satış · SL −%1,5 · TP1 öncesi 60 dk · %30 runner: maliyet stopu / 17:40</p><div id="scalpOpen"></div><h3 id="scalpQueueTitle" tabindex="-1">Pusudaki Scalp yedekleri</h3><small>Onaydan itibaren en fazla 15 dakika</small><div id="scalpQueue"></div></section>
<section class="room trend" id="trendRoom"><div class="row"><h2>📈 TREND / SWING ODASI</h2><span class="badge">60 dk & Günlük</span></div><p class="rule">EMA200 · SüperTrend · VWAP · Net +%4'te yarım satış · Kalan lotlarda maliyet koruması ve 2 bar trailing · En fazla 5 işlem seansı</p><div id="trendOpen"></div><h3 id="trendQueueTitle" tabindex="-1">Pusudaki Trend yedekleri</h3><small>berker3 öncelikli · Geçerlilik gün sonuna kadar</small><div id="trendQueue"></div></section></div>
<section class="settings" id="history"><h2>Geçmiş işlemler</h2><div class="tabs" id="filters"><button data-filter="ALL" class="active">Tümü</button><button data-filter="SCALP">Scalp çıkışları</button><button data-filter="SWING">Trend çıkışları</button></div><div id="historyRows"></div></section>
<h2 hidden>Açık İşlemler</h2><div class="empty" id="demoOpen" hidden>Açık sanal işlem bulunmuyor.</div><h2>Gemini için Denetim Karnesi</h2><button id="copyReport">📋 Karneyi kopyala</button><p id="reportStatus" aria-live="polite"></p><textarea id="reportResult" readonly rows="12" style="width:100%;box-sizing:border-box;background:#0b1420;color:#eef5ff;border:1px solid #405269;border-radius:14px;padding:12px" placeholder="Karne burada hazırlanır."></textarea><button id="selectReport">Karne metnini seç</button><h2 hidden>Kapanan İşlemler</h2><div class="empty" id="demoClosed" hidden>Henüz kapanan işlem yok.</div></div>
<div id="settings" class="page"><h2>⚙️ Ayarlar ve Bağlantılar</h2><div class="panel"><p>Mevcut erişim tokenını girince Gemini, GPT ve radar durumu otomatik kontrol edilir. Token cihazda saklanmaz.</p><input id="token" type="password" autocomplete="off" placeholder="ACCESS_TOKEN"><button id="check">🔌 API bağlantılarını kontrol et</button><pre id="checkResult">Token bekleniyor.</pre><button id="pushOn">🔔 iPhone bildirimlerini etkinleştir</button><button id="pushTest">🔔 Test bildirimi gönder</button><pre id="pushStatus">Bildirimleri etkinleştir; ardından test bildirimi gönder.</pre></div><h2>📋 Ortak Teknik Belge</h2><div class="panel"><p>GPT ve Gemini için güncel teknik belge.</p><button id="copyDoc">📋 Teknik belge bağlantısını kopyala</button><p id="copyStatus" class="muted">Gemini sohbetine yapıştırabilirsin.</p></div><h2>🌙 Gece taraması</h2><div class="panel"><p>Son kapanmış günlük mumlarla sistemin kendi testini çalıştır. Onaylı AL sinyali değil, teknik radar testidir.</p><button id="nightTest">🌙 Bulut besleme durumunu göster</button><pre id="nightResult">Henüz bu oturumdan başlatılmadı.</pre></div><h2>berker3 öncelik listesi</h2><input id="berker3" placeholder="BORLS, REEDR, BINHO, ASTOR"><button id="saveBerker3">Listeyi kaydet</button><pre id="berker3Status"></pre><button id="pushTest">Test bildirimi gönder</button><h2>Diagnostik</h2><div class="panel"><p>Gemini üretim testleri AI kotası kullanabilir.</p><button id="plain">Basit Gemini testi</button><button id="ground">Gemini Google Search testi</button><pre id="testResult">Henüz test edilmedi.</pre></div></div>
<dialog id="detailDialog" style="background:#152031;color:#eef5ff;border:1px solid #405269;border-radius:20px;max-width:90vw"><h2 id="detailTitle"></h2><pre id="detailBody" style="white-space:pre-wrap"></pre><button id="detailClose">Kapat</button></dialog></main><nav class="nav"><button data-page="candidates"><b>◉</b>Adaylar</button><button class="active" data-page="home"><b>⌂</b>Ana</button><button data-page="radar"><b>◎</b>Radar</button><button data-page="signals"><b>✓</b>Sinyaller</button><button data-page="demo"><b>▣</b>Demo</button><button data-page="settings"><b>⚙</b>Ayarlar</button></nav>
<script>
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
function showDetails(title,value){document.getElementById('detailTitle').textContent=title;document.getElementById('detailBody').textContent=value;document.getElementById('detailDialog').showModal()}
document.getElementById('detailClose').onclick=()=>document.getElementById('detailDialog').close();
const token=document.getElementById('token');let pending=false,lastData=null;const headers=()=>token.value.trim()?({Authorization:'Bearer '+token.value.trim()}):({});const money=n=>Number(n||0).toLocaleString('tr-TR',{minimumFractionDigits:2,maximumFractionDigits:2})+' TL';
function navigate(p){document.querySelectorAll('[data-page]').forEach(x=>x.classList.toggle('active',x.dataset.page===p));document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id===p));window.scrollTo(0,0);void checkApis(true)}
document.querySelectorAll('[data-queue-target]').forEach(button=>{button.onclick=()=>{navigate('demo');const heading=document.getElementById(button.dataset.queueTarget==='SCALP'?'scalpQueueTitle':'trendQueueTitle');heading.focus({preventScroll:true});heading.scrollIntoView({block:'start'});};});
document.querySelectorAll('[data-jump]').forEach(x=>{x.onclick=()=>navigate(x.dataset.jump);x.onkeydown=e=>{if(e.key==='Enter')x.click()}});
document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-page]').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id===b.dataset.page));window.scrollTo(0,0);void checkApis(true)});
document.querySelectorAll('[data-candidate-filter]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-candidate-filter]').forEach(x=>x.classList.toggle('active',x===b));if(lastData)renderOverview(lastData)});
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('active',x===b));if(lastData)renderOverview(lastData)});
function setDot(which,state,text){document.getElementById(which+'Dot').className='dot '+state;document.getElementById(which+'Text').textContent=text}
document.getElementById('selectReport').onclick=()=>{const out=document.getElementById('reportResult');out.focus();out.select();out.setSelectionRange(0,out.value.length);document.getElementById('reportStatus').textContent='Metin seçildi; iPhone menüsünden Kopyala seçebilirsin.'};
document.getElementById('copyReport').onclick=()=>{const out=document.getElementById('reportResult'),status=document.getElementById('reportStatus');if(!lastData){status.textContent='Panel verisi henüz gelmedi; Ayarlar bölümünden bağlantıyı kontrol et.';return}const text='BIST anlık sanal işlem karnesi\nhttps://github.com/baykatemizlik-dotcom/ai-evi/blob/main/CLOUD_BRIDGE.md\n'+JSON.stringify({...lastData,panel_report_at:new Date().toISOString()},null,2);out.value=text;
 const fallback=()=>{out.focus();out.select();out.setSelectionRange(0,text.length);try{if(document.execCommand('copy')){status.textContent='Karne kopyalandı ✅';return}}catch{}status.textContent='Karne hazır ve seçili. Metne uzun basıp Kopyala seçebilirsin.'};
 if(navigator.clipboard?.writeText){try{navigator.clipboard.writeText(text).then(()=>{status.textContent='Karne kopyalandı ✅'},fallback)}catch{fallback()}}else fallback();};
async function checkApis(silent=false){if(pending)return;pending=true;if(!silent){setDot('gemini','wait','Kontrol');setDot('gpt','wait','Kontrol');}try{
const [a,b,c]=await Promise.all([fetch('/bist/connections',{headers:headers()}),fetch('/bist/overview',{headers:headers()}),fetch('/bist/status',{headers:headers()})]);const x=await a.json(),o=await b.json(),status=await c.json();if(a.status===401){setDot('gemini','','Oturum gerekli');setDot('gpt','','Oturum gerekli');document.getElementById('checkResult').textContent='Bir defa erişim tokenı girerek oturum aç.';return}document.getElementById('checkResult').textContent=JSON.stringify(x,null,2);for(const [label,field] of [['gemini','gemini'],['gpt','openai']]){const ok=a.ok&&x[field]&&x[field].connection==='CONNECTED';setDot(label,ok?'ok':'bad',ok?'Bağlı':(field==='openai'?(x.openai?.connection==='CONFIGURED'?'Mini hazır · ilk karar bekleniyor':x.openai?.connection==='ERROR'?'Mini API hatası':'Mini anahtarı eksik'):x.gemini?.connection==='ERROR'?'Gemini API hatası':'Bulut Gemini testi bekleniyor'))}if(!b.ok)throw Error('Panel verisi güncellenemedi: HTTP '+b.status);lastData=o;renderOverview(o);document.getElementById('mainState').textContent=status.scanner_live?'Bulut radar aktif':'Veri bekleniyor';
}catch(e){setDot('gemini','bad','Hata');setDot('gpt','bad','Hata');document.getElementById('panelFreshness').textContent='Panel yenilenemedi · son kayıtlar gösteriliyor';document.getElementById('checkResult').textContent=String(e.message)}finally{pending=false}}
function renderOverview(d){
 const stamp=value=>value?new Date(value).toLocaleString('tr-TR',{timeZone:'Europe/Istanbul'}):'—';
 const states={READY:'Slot bekliyor',INVALID:'Koşul geçersiz',PENDING:'Giriş bekliyor',ENTERED:'Sanal alım yapıldı',EXPIRED:'Giriş süresi doldu',OPEN:'Açık sanal işlem',CLOSED:'Sanal işlem kapandı'};
 const filter=document.querySelector('[data-filter].active')?.dataset.filter||'ALL';
 for(const id of ['signalsHome','signalsPage']){const container=document.getElementById(id);container.replaceChildren();
  for(const s of (d.ai_signals||[]).filter(x=>id==='signalsPage'||filter==='ALL'||(x.strategy||'SCALP')===filter)){
   const card=document.createElement('button');card.style.display='block';card.style.width='100%';
   const state=s.trade_status?states[s.trade_status]:s.signal_status==='PENDING'&&Date.parse(s.expires_at)<Date.now()?states.EXPIRED:states[s.signal_status]||'Bağlantı kontrolü · giriş sinyali yok';
   card.textContent=s.symbol+' · '+state+' · Mini güven '+s.confidence+'/100';
   card.onclick=()=>showDetails(s.symbol+' · sanal sinyal',
    'Durum: '+state+'\nMotor: '+(s.strategy==='SWING'?'TREND':s.strategy||'Giriş bekleniyor')+'\nMini onay zamanı: '+stamp(s.completed_at)+'\nSinyal mumu: '+stamp(s.bar_time)+'\nGüven: '+s.confidence+'/100\nNeden: '+s.reason+'\nGiriş: '+(s.executed_price?money(s.executed_price):'Henüz yok')+'\nLot: '+(s.lot_count||0)+'\nGiriş barı: '+stamp(s.entry_time)+'\nÇıkış: '+stamp(s.exit_time)+'\nNet gerçekleşen K/Z: '+(s.pnl_net==null?'Henüz kapanmadı':money(s.pnl_net)));
   container.append(card);
  }if(!container.children.length)container.textContent='Bugün mini onaylı kayıt yok.';
 }
 document.getElementById('pnl').textContent=money(d.realised_pnl||0)+' · '+(d.open_trades||[]).length+' açık sanal işlem';
 document.getElementById('radarState').textContent='Son tarama: '+(d.last_scan_fetched||0)+' / '+(d.eligible_total||0)+' hisse · '+(d.stage1_hot||0)+' sıcak aday · '+(d.watchlist||[]).length+' teknik filtreyi geçen · '+(d.scanner_live?'Veri taze':'Veri bayat');
 
 const trt=value=>value?new Date(value).toLocaleTimeString('tr-TR',{timeZone:'Europe/Istanbul',hour:'2-digit',minute:'2-digit'}):'bekleniyor';
 document.getElementById('panelFreshness').textContent='Panel güncellendi '+new Date().toLocaleTimeString('tr-TR',{timeZone:'Europe/Istanbul'})+' · 5 sn';document.getElementById('scanTime').textContent='Son tarama '+trt(d.last_scan_at)+' TRT';
 document.getElementById('feedDetail').textContent='Son mum başlangıcı '+trt(d.last_scan_bar)+' TRT · '+(d.shards_completed||0)+'/8 parça · '+(d.pending_entries||0)+' bekleyen giriş · '+[...(d.scalp_sniper_queue||[]),...(d.trend_radar_queue||[])].length+' taze yedek · '+(d.scanner_live?'Veri taze':'Veri bayat; giriş kapalı');
 
 const standby=document.getElementById('sniperStandby');standby.replaceChildren();
 for(const [rank,q] of [...(d.scalp_sniper_queue||[]),...(d.trend_radar_queue||[])].entries()){const el=document.createElement('div');el.className='tile';el.textContent=(rank+1)+'. '+q.symbol+' · Puan '+Number(q.score||0).toFixed(2)+' · '+(Date.parse(q.expires_at)>Date.now()?'Geçerli':'Süresi doldu')+' · '+q.reason+' · Son mum '+new Date(q.bar_time).toLocaleString('tr-TR',{timeZone:'Europe/Istanbul'});standby.append(el);}
 if(!standby.children.length){const el=document.createElement('div');el.className='empty';el.textContent='Mini onaylı taze yedek bekleniyor.';standby.append(el);}
 const sniper=(d.open_trades||[]).find(t=>t.strategy==='SWING');document.getElementById('sniperPosition').textContent=sniper?'TREND · '+sniper.symbol+' · '+sniper.remaining_lots+' lot · Stop '+money(sniper.trailing_stop)+' · '+d.trend_slots+'/2 slot · Boş nakit '+money(d.swing_cash):'İki slot boş · Kasa '+money(d.swing_cash)+' · '+d.trend_slots+'/2 slot';
 const cap=Number(d.equity||d.total_capital||5000);document.getElementById('total').textContent=money(cap);document.getElementById('demoTotal').textContent=money(cap);document.getElementById('scalpCash').textContent=money(d.scalp_cash)+' · '+d.scalp_slots+'/2 slot';document.getElementById('swingCash').textContent=money(d.swing_cash)+' · '+d.trend_slots+'/2 slot';document.getElementById('approved').textContent=String(d.approved||0);document.getElementById('candidateCount').textContent=String(d.candidates||0);document.getElementById('scanned').textContent=String(d.last_scan_fetched||d.scanned||0);document.getElementById('lastRun').textContent=d.last_scan_at?'Son mum başlangıcı '+trt(d.last_scan_bar)+' TRT · '+d.shards_completed+'/8 parça · '+(d.scanner_live?'Veri taze':'Yeni veri bekleniyor; son tarama gösteriliyor'):'Henüz tarama kaydı yok';document.getElementById('marketState').textContent=d.scanner_live?'Bulut verisi aktif · gösterge niteliğinde':'Taze 15m veri bekleniyor';document.getElementById('xuState').textContent=d.last_scan_at?trt(d.last_scan_at)+' TRT · '+d.last_scan_fetched+' hisse':'Henüz tarama kaydı yok';document.getElementById('watchlist').textContent=d.candidates>0?'Son taramada '+d.candidates+' sıcak aday · Teknik adaylar ve yedekler için dokun →':'Son taramada sıcak aday yok; yedek havuzu ayrıca izlenir.';
const list=document.getElementById('candidateList');list.replaceChildren();const candidateFilter=document.querySelector('[data-candidate-filter].active')?.dataset.candidateFilter||'ALL';
for(const a of (d.watchlist||[]).filter(x=>candidateFilter==='ALL'||x.strategy===candidateFilter)){const b=document.createElement('button');b.textContent=(a.strategy==='SCALP'?'⚡ SCALP':a.strategy==='SWING'?'🎯 TREND':a.strategy==='WHALE'?'🐋 BALİNA':'STRATEJİ BELİRSİZ')+' · '+a.symbol+' · '+(a.verified?'Doğrulandı':'Teyit bekliyor')+' · '+a.source+' · '+(a.ai_status||'Mini değerlendirmesi bekleniyor')+' · '+({READY:'Slot bekliyor',ENTERED:'İşleme girildi',EXPIRED:'Süresi doldu',INVALID:'Koşul geçersiz',NOT_APPROVED:'Onay bekliyor'}[a.candidate_status]||a.candidate_status||'');b.onclick=()=>alert('Hisse: '+a.symbol+'\nKaynak: '+a.source+'\nDurum: '+(a.verified?'Doğrulandı':'Teyit bekliyor')+'\nAday durumu: '+(a.candidate_status||'Onay bekliyor')+'\nAL sinyali değildir.');list.append(b)}
if(!list.children.length){const e=document.createElement('div');e.className='empty';e.textContent='Doğrulanmış aday bulunmuyor.';list.append(e)}
const slots=document.getElementById('scalpSlots');slots.replaceChildren();for(const id of [1,2]){const t=(d.open_trades||[]).find(x=>x.strategy==='SCALP'&&x.slot_id===id);const el=document.createElement('div');el.className='tile';el.tabIndex=0;el.setAttribute('role','button');el.onclick=()=>showDetails('SCALP Slot '+id,t?'Hisse: '+t.symbol+'\nLot: '+t.lot_count+'\nGiriş fiyatı: '+money(t.executed_price)+'\nGiriş barı: '+stamp(t.entry_time)+'\nKomisyon: '+money(t.commission)+'\nDurum: Açık sanal işlem':'Slot boş');el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();el.click()}};el.textContent=t?'Slot '+id+' · '+t.symbol+' · '+t.lot_count+' lot':'Slot '+id+' · Boş · 1.250 TL';slots.append(el)}const o=d.open_trades||[],c=d.closed_trades||[];document.getElementById('demoOpen').style.whiteSpace='pre-line';document.getElementById('openHome').style.whiteSpace='pre-line';const openText=o.length?o.map(x=>x.strategy+' · '+x.symbol+' · '+(x.remaining_lots??x.lot_count)+' lot · '+money(x.executed_price)).join('\n'):'Henüz sanal işlem açılmadı.';document.getElementById('openHome').textContent=openText;const demo=document.getElementById('demoOpen');demo.replaceChildren();
 for(const t of o){const cost=t.executed_price*t.lot_count+t.commission,scalp=t.strategy==='SCALP',stop=scalp?cost*.985/(t.lot_count*.998*.998):d.sniper_state?.stop_price,tp=scalp?cost*1.03/(t.lot_count*.998*.998):null;
 const card=document.createElement('button');card.style.width='100%';card.style.display='block';
 const detail=(scalp?'SCALP':'TREND')+' · '+t.symbol+'\n'+t.lot_count+' lot · Giriş '+money(t.executed_price)+'\nGiriş barı: '+stamp(t.entry_time)+'\nToplam maliyet: '+money(cost)+' · Komisyon: '+money(t.commission)+'\nStop eşik fiyatı: '+money(stop)+' · '+(tp?'TP eşik fiyatı: '+money(tp):'Dinamik takip stopu')+'\nDurum: Açık sanal işlem';
 card.style.whiteSpace='pre-line';card.textContent=detail;card.onclick=()=>showDetails(t.symbol+' · işlem ayrıntısı',detail);demo.append(card);
 }if(!o.length)demo.textContent='Henüz açık sanal işlem yok.';document.getElementById('demoClosed').textContent=c.length?c.map(x=>x.symbol+' · Net K/Z '+money(x.pnl_net)).join('\n'):'Henüz kapanan işlem yok.';document.getElementById('performanceHome').textContent=c.length?'Kapanan işlem: '+c.length+' · Net toplam: '+money(c.reduce((sum,x)=>sum+Number(x.pnl_net||0),0)):'Henüz kapanan işlem yok.'
 document.getElementById('homeScalpReserveCount').textContent=(d.scalp_sniper_queue||[]).length;document.getElementById('homeTrendReserveCount').textContent=(d.trend_radar_queue||[]).length;
 offset=Date.parse(d.server_time)-Date.now();renderOpen('scalpOpen','SCALP');renderOpen('trendOpen','SWING');renderQueue('scalpQueue',d.scalp_sniper_queue||[],false);renderQueue('trendQueue',d.trend_radar_queue||[],true);renderHistory();timers();
}
async function loginAndCheck(){if(token.value.trim()){const r=await fetch('/bist/session',{method:'POST',headers:{Authorization:'Bearer '+token.value.trim()}});if(!r.ok){document.getElementById('checkResult').textContent='Erişim tokenı hatalı';return}token.value=''}await checkApis()}token.addEventListener('change',loginAndCheck);document.getElementById('check').onclick=loginAndCheck;checkApis();setInterval(()=>{if(!document.hidden)void checkApis(true)},5000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void checkApis(true)});
document.getElementById('go').onclick=async()=>{const sym=document.getElementById('symbol').value.trim().toUpperCase(),out=document.getElementById('result');if(!/^[A-Z0-9]{3,6}$/.test(sym)){out.textContent='Geçersiz sembol';return}out.textContent='Araştırılıyor';try{const r=await fetch('/bist/research',{method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:JSON.stringify({symbol:sym})});out.textContent='HTTP '+r.status+'\n'+JSON.stringify(await r.json(),null,2)}catch(e){out.textContent=String(e)}};
document.getElementById('nightTest').onclick=async()=>{const b=document.getElementById('nightTest'),o=document.getElementById('nightResult');b.disabled=true;o.textContent='Bot kapanmış mumları tarıyor...';try{const r=await fetch('/bist/status',{headers:headers()});const j=await r.json();o.textContent='HTTP '+r.status+'\\n'+JSON.stringify(j,null,2);if(r.ok)await checkApis()}catch(e){o.textContent='Tarama hatası: '+e.message}finally{b.disabled=false}};
document.getElementById('copyDoc').onclick=async()=>{const link='https://docs.google.com/document/d/1G6Gj9O0dPHaNY0MdWhEp_F3EKyn_Q0sC9RaV9cxY2uk/edit';try{await navigator.clipboard.writeText(link);document.getElementById('copyStatus').textContent='Bağlantı kopyalandı ✅'}catch{document.getElementById('copyStatus').textContent='Kopyalanamadı. Belge bağlantısı: '+link}};
async function testPush(){const out=document.getElementById('pushStatus');try{const reg=await navigator.serviceWorker.ready;const sub=await reg.pushManager.getSubscription();if(!sub)throw Error('Önce bildirimleri etkinleştir.');const r=await fetch('/push/test',{method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:JSON.stringify({endpoint:sub.endpoint})});const data=await r.json();if(!r.ok||!data.accepted)throw Error('Test gönderilemedi; bildirimleri yeniden etkinleştir.');out.textContent='Test bildirimi telefonun bildirim servisine iletildi. Bildirim gelmezse iPhone bildirim ve Odak ayarlarını kontrol et.';}catch(e){out.textContent=e.message;}}
document.getElementById('pushTest').onclick=testPush;
document.getElementById('pushOn').onclick=async()=>{const out=document.getElementById('pushStatus');try{if(!('serviceWorker'in navigator)||!('PushManager'in window)||!('Notification'in window))throw Error('iPhone: Safari → Paylaş → Ana Ekrana Ekle. Paneli ana ekrandan aç.');const permission=await Notification.requestPermission();if(permission!=='granted')throw Error('Bildirim izni verilmedi. iPhone Ayarlar → Bildirimler bölümünden izin ver.');out.textContent='Bildirim bağlantısı kuruluyor…';await navigator.serviceWorker.register('/sw.js');const reg=await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Sayfayı yenileyip tekrar dene.')),20000))]);const k=await fetch('/push/key',{headers:headers()});if(!k.ok)throw Error('Bildirim servisi hazır değil.');const j=await k.json();const base=j.key.replace(/-/g,'+').replace(/_/g,'/');const bytes=Uint8Array.from(atob(base.padEnd(Math.ceil(base.length/4)*4,'=')),x=>x.charCodeAt(0));let sub=await reg.pushManager.getSubscription();if(sub&&sub.options.applicationServerKey){const prev=new Uint8Array(sub.options.applicationServerKey);if(prev.length!==bytes.length||prev.some((v,i)=>v!==bytes[i])){await sub.unsubscribe();sub=null;}}sub=sub||await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});const r=await fetch('/push/subscribe',{method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:JSON.stringify(sub)});if(!r.ok)throw Error('Abonelik kaydedilemedi; panel girişini kontrol et.');out.textContent='Bildirimler etkin. Test bildirimi gönderiliyor…';await testPush();}catch(e){out.textContent=e.message}};
for(const [id,mode] of [['plain','plain'],['ground','grounding']])document.getElementById(id).onclick=async()=>{const out=document.getElementById('testResult');out.textContent='Test yapılıyor';try{const r=await fetch('/bist/gemini-test?mode='+mode,{headers:headers()});out.textContent='HTTP '+r.status+'\n'+JSON.stringify(await r.json(),null,2)}catch(e){out.textContent=String(e)}};
const el=id=>document.getElementById(id),price=n=>Number(n||0).toLocaleString('tr-TR',{maximumFractionDigits:4}),stamp=t=>t?new Date(t).toLocaleString('tr-TR',{timeZone:'Europe/Istanbul'}):'—';let historyFilter='ALL',offset=0;const clock=()=>Date.now()+offset;
const reasons={SCALP_TP1:'SCALP_TP1 (+%3 net) · %70 satış',SCALP_RUNNER_BE:'Runner · Net maliyet stopu',SCALP_RUNNER_EOD:'Runner · 17:40 gün sonu',TP_NET_3:'TP (+%3 net)',TP_NET_3_PCT:'TP (+%3 net)',SL_NET_1_5:'SL (−%1,5 net)',STOP_NET_1_5_PCT:'SL (−%1,5 net)',TIME_EXIT:'TIME_EXIT · 60 dakika',SCALP_EOD_1740:'Gün sonu · 17:40',TREND_TP1:'TREND_TP1 (+%4 net)',TREND_TRAILING:'TREND_TRAILING · İz süren stop',TREND_INITIAL_STOP:'Trend · İlk SüperTrend stopu',TREND_MAX_5_SESSIONS:'Trend · 5 işlem seansı',MANUAL_CLOSE:'Manuel sanal kapanış',MANUAL_FORCE_CLOSE:'Manuel sanal kapanış'};
function node(tag,text,cls){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;}
function kv(parent,label,value){const n=node('div');n.append(node('small',label),node('b',value));parent.append(n);}
function empty(parent,text){parent.append(node('p',text,'empty'));}
function orderCard(symbol,entry,lots,tp1Done=false){const card=node('section',null,'queue');card.append(node('h4','Emir Kurulum Kartı'),node('b',symbol+' @ '+price(entry)),node('p','İlk Stop (SL %100): '+price(entry*.985)),node('p','Zincir Emir (TP1 %70 Satış): '+price(entry*1.03)+(lots?' · '+Math.floor(lots*.7)+'/'+lots+' lot':'')),node('p',tp1Done?'Runner aktif · '+(lots-Math.floor(lots*.7))+' lot · Maliyet stopu '+price(entry):'Runner: Kalan %30 · TP1 sonrası maliyet stopu '+price(entry)),node('small','Brüt emir fiyatları. Botun net eşikleri ücretleri içerir. QNB fiyat adımı ve emir türünü kontrol et.'));
 const status=node('p');status.setAttribute('aria-live','polite');for(const [label,value] of [['Fiyat Kopyala',entry],['Stop Kopyala',entry*.985],['TP1 Kopyala',entry*1.03]]){const b=node('button',label);b.onclick=async()=>{const text=String(Number(value.toFixed(4))).replace('.',',');try{await navigator.clipboard.writeText(text);status.textContent=label+': Kopyalandı.';}catch{const field=node('input');field.value=text;field.readOnly=true;card.append(field);field.focus();field.select();status.textContent='Fiyat seçildi; Kopyala seçebilirsin.';}};card.append(b);}card.append(status);return card;}
function renderOpen(id,strategy){const box=el(id);box.replaceChildren();const trades=(lastData.open_trades||[]).filter(t=>t.strategy===strategy);
 for(const t of trades){const card=node('article',null,'card'),head=node('div',null,'row');head.append(node('h3',t.symbol+' · Slot '+t.slot_id),node('span',t.remaining_lots+' lot','badge'));card.append(head,node('div',price(t.current_price)+' TL','price'),node('div',(t.unrealised_pct>=0?'+':'')+t.unrealised_pct.toFixed(2)+'% · '+money(t.unrealised_net),t.unrealised_net>=0?'gain':'loss'));
 const fields=node('div',null,'kv');kv(fields,'Giriş',price(t.executed_price)+' TL');kv(fields,'Fiyat zamanı',stamp(t.quote_time));kv(fields,'İcra zamanı',stamp(t.entry_observed_at||t.entry_time));kv(fields,'Fiyat durumu',t.quote_fresh?'Gecikmeli gösterge · '+Math.floor(t.quote_age_minutes||0)+' dk':'Bayat / fiyat bekleniyor');
 if(strategy==='SCALP'){kv(fields,'Bot net TP1 / ilk SL',price(t.thresholds.tp)+' / '+price(t.thresholds.sl));kv(fields,'Runner durumu',t.tp1_done?'TP1 alındı · '+t.remaining_lots+'/'+t.lot_count+' lot · 17:40’a taşınıyor':'TP1 bekleniyor · %70 satış / %30 runner');if(t.tp1_done)kv(fields,'Bot net maliyet stopu',price(t.thresholds.breakeven));const timer=node('b');timer.dataset.entry=t.entry_time;if(t.tp1_done)timer.dataset.runner='1';fields.append(node('div','Geçen / kalan süre'),timer);}else{kv(fields,'Kademeli durum',t.tp1_done?'TP1 alındı · '+t.remaining_lots+'/'+t.lot_count+' lot taşınıyor':'TP1 bekleniyor');kv(fields,'Stop seviyesi',price(t.trailing_stop)+' TL');kv(fields,'TP1 eşik',price(t.thresholds.tp)+' TL');kv(fields,'Başlangıç lotu',String(t.lot_count));}
 card.append(fields);const button=node('button','Sanal pozisyonu kapat','close');button.disabled=!t.quote_fresh;button.onclick=async()=>{button.disabled=true;button.textContent='Kapatılıyor…';try{const r=await fetch('/bist/strategy/close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({trade_id:t.id,strategy:t.strategy})});const x=await r.json();if(!r.ok)throw Error(x.error==='FRESH_QUOTE_REQUIRED'?'Taze fiyat bekleniyor.':'Kapatma başarısız; paneli yenile.');await checkApis(true);}catch(e){button.textContent=e.message;button.disabled=false;}};card.append(button);if(strategy==='SCALP')card.append(orderCard(t.symbol,t.executed_price,t.lot_count,!!t.tp1_done));box.append(card);}
 for(const slot of [1,2])if(!trades.some(t=>t.slot_id===slot)){const card=node('article',null,'card');card.append(node('b','Slot '+slot+' · Boş'),node('p','1.250 TL tavan · Uygun ve geçerli aday bekleniyor.'));box.append(card);}if(!trades.length)empty(box,'İki slot da boş; uygun aday bekleniyor.');
}
function renderQueue(id,rows,trend){const box=el(id);box.replaceChildren();for(const [i,q] of rows.entries()){const n=node('div',null,'queue');n.append(node('b',(i+1)+'. '+q.symbol+(trend&&q.priority?' · berker3':'')),node('p','Puan '+q.score.toFixed(2)+' · '+q.reason),node('small','Son geçerlilik: '+stamp(q.expires_at)));if(!trend&&q.indicative_price>0){n.append(node('small','Gösterge fiyatından taslak · '+stamp(q.quote_time)),orderCard(q.symbol,q.indicative_price,null));}box.append(n);}if(!rows.length)empty(box,'Hazır yedek yok.');}
function renderHistory(){const box=el('historyRows');box.replaceChildren();for(const t of (lastData.exit_history||[]).filter(t=>historyFilter==='ALL'||t.strategy===historyFilter)){const n=node('article',null,'history');n.append(node('b',t.symbol+' · '+(t.strategy==='SCALP'?'Scalp':'Trend')+' · '+t.qty+' lot'),node('p',reasons[t.reason]||t.reason),node('span',money(t.pnl_net),t.pnl_net>=0?'gain':'loss'),node('p','Satış '+price(t.executed_price)+' TL · '+stamp(t.observed_at||t.exit_time),'muted'));box.append(n);}if(!box.children.length)empty(box,'Bu filtrede satış kaydı yok.');}
function timers(){document.querySelectorAll('[data-entry]').forEach(n=>{const mins=Math.max(0,(clock()-Date.parse(n.dataset.entry))/60000),remain=Math.max(0,60-mins);if(n.dataset.runner){const eod=Date.parse(n.dataset.entry.slice(0,10)+'T14:40:00Z');n.textContent='Runner · 17:40’a kalan '+Math.max(0,Math.ceil((eod-clock())/60000))+' dk';return;}n.textContent=Math.floor(mins)+'/60 dk · Kalan '+Math.ceil(remain)+' dk'+(remain===0?' · Çıkış fiyatı bekleniyor':'');});}
async function testPush(){try{if(!('serviceWorker'in navigator)||!('PushManager'in window))throw Error('Paneli ana ekrandan açıp bildirimleri etkinleştir.');const reg=await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Sayfayı yenileyip tekrar dene.')),20000))]);const sub=await reg.pushManager.getSubscription();if(!sub)throw Error('Önce bildirimleri etkinleştir.');const r=await fetch('/push/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:sub.endpoint})});const x=await r.json();if(!r.ok||!x.accepted)throw Error('Test gönderilemedi; bildirimleri yeniden etkinleştir.');el('pushStatus').textContent='Test bildirim servisine iletildi. Telefonda görünmüyorsa bildirim ve Odak ayarlarını kontrol et.';}catch(e){el('pushStatus').textContent=e.message;}}
el('pushTest').onclick=testPush;
el('pushOn').onclick=async()=>{try{if(!('Notification'in window)||!('PushManager'in window))throw Error('Safari → Paylaş → Ana Ekrana Ekle; paneli ana ekrandan aç.');if(await Notification.requestPermission()!=='granted')throw Error('Bildirim izni verilmedi. iPhone bildirim ayarlarını kontrol et.');await navigator.serviceWorker.register('/sw.js');const reg=await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Sayfayı yenileyip tekrar dene.')),20000))]);const r=await fetch('/push/key');if(!r.ok)throw Error('Bildirim servisi hazır değil; panel girişini kontrol et.');const x=await r.json(),base=x.key.replace(/-/g,'+').replace(/_/g,'/'),key=Uint8Array.from(atob(base.padEnd(Math.ceil(base.length/4)*4,'=')),c=>c.charCodeAt(0));let sub=await reg.pushManager.getSubscription();if(sub?.options.applicationServerKey){const prev=new Uint8Array(sub.options.applicationServerKey);if(prev.length!==key.length||prev.some((v,i)=>v!==key[i])){await sub.unsubscribe();sub=null;}}sub=sub||await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});const saved=await fetch('/push/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sub)});if(!saved.ok)throw Error('Abonelik kaydedilemedi.');await testPush();}catch(e){el('pushStatus').textContent=e.message;}};

el('filters').querySelectorAll('button').forEach(b=>b.onclick=()=>{historyFilter=b.dataset.filter;el('filters').querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));if(lastData)renderHistory();});
el('saveBerker3').onclick=async()=>{try{const symbols=[...new Set(el('berker3').value.toUpperCase().split(/[\s,;]+/).filter(Boolean))];const r=await fetch('/bist/strategy/berker3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbols})});el('berker3Status').textContent=r.ok?'Liste kaydedildi.':'Liste kaydedilemedi.';}catch{el('berker3Status').textContent='Bağlantı hatası.';}};
fetch('/bist/strategy/berker3').then(r=>r.ok?r.json():null).then(d=>{if(d)el('berker3').value=d.symbols.join(', ')}).catch(()=>{});
setInterval(()=>{if(!document.hidden)timers();},1000);
</script></body></html>
`;
 if((u.pathname==="/"||u.pathname==="/bist")&&request.method==="GET")return new Response(dashboard,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"}});
 if(u.pathname==="/manifest.json")return new Response(JSON.stringify({name:"BIST AVCI",short_name:"BIST AVCI",start_url:"/",scope:"/",display:"standalone",background_color:"#0c1220",theme_color:"#0c1220",icons:[{src:"/icon.svg",sizes:"any",type:"image/svg+xml",purpose:"any maskable"}]}),{headers:{"Content-Type":"application/manifest+json","Cache-Control":"max-age=300"}});
 if(u.pathname==="/icon.svg")return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192"><rect width="192" height="192" rx="36" fill="#0c1220"/><path d="M30 140 L65 105 L92 121 L135 59 L165 72" fill="none" stroke="#58d0a0" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/><text x="26" y="50" fill="white" font-size="27" font-family="sans-serif">BIST</text></svg>',{headers:{"Content-Type":"image/svg+xml","Cache-Control":"max-age=86400"}});
 if(u.pathname==="/sw.js")return new Response("self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('push',e=>{let x={title:'BIST AVCI',body:'Yeni doğrulanmış sinyal var. Paneli açıp kontrol et.'};try{if(e.data)x={...x,...e.data.json()}}catch{}e.waitUntil(self.registration.showNotification(x.title,{body:x.body,icon:'/icon.svg',tag:x.tag||'bist-signal',data:{url:'/'}}))});self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(self.clients.openWindow('/'))})",{headers:{"Content-Type":"application/javascript","Service-Worker-Allowed":"/","Cache-Control":"no-cache"}});
 const bearer=request.headers.get("Authorization")||"";
 const provided=bearer.startsWith("Bearer ")?bearer.slice(7):"";
 const constantEqual=(x,y)=>{if(x.length!==y.length)return false;let d=0;for(let i=0;i<x.length;i++)d|=x.charCodeAt(i)^y.charCodeAt(i);return d===0};
 const key=env.ACCESS_TOKEN?await crypto.subtle.importKey("raw",new TextEncoder().encode(env.ACCESS_TOKEN),{name:"HMAC",hash:"SHA-256"},false,["sign"]):null;
 const sign=async msg=>{const bytes=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(msg)));return [...bytes].map(x=>x.toString(16).padStart(2,"0")).join("")};
 const cookies=request.headers.get("Cookie")||"";
 const session=(cookies.match(/(?:^|;\s*)bist_session=([^;]+)/)||[])[1]||"";
 let authenticated=false;
 if(provided&&env.ACCESS_TOKEN){const [a,b]=await Promise.all([hash(provided),hash(env.ACCESS_TOKEN)]);let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];authenticated=diff===0}
 if(!authenticated&&key&&session){const [exp,sig]=session.split(".");const n=Number(exp);if(/^\d{10,13}$/.test(exp||"")&&n>Date.now()&&n<Date.now()+15*86400000&&/^[a-f0-9]{64}$/.test(sig||""))authenticated=constantEqual(sig,await sign(exp))}
 if(u.pathname==="/bist/session"&&request.method==="POST"){
   if(!authenticated||!provided)return reply({error:"Invalid access token"},401);
   const exp=String(Date.now()+14*86400000);
   return new Response(JSON.stringify({ok:true,expires_at:new Date(Number(exp)).toISOString()}),{status:200,headers:{"Content-Type":"application/json","Cache-Control":"no-store","Set-Cookie":"bist_session="+exp+"."+await sign(exp)+"; Max-Age=1209600; Path=/; HttpOnly; Secure; SameSite=Strict"}});
 }
 if(u.pathname==="/bist/logout"&&request.method==="POST")return new Response(JSON.stringify({ok:true}),{headers:{"Content-Type":"application/json","Set-Cookie":"bist_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict"}});
 if(['/bist/feed/trend','/bist/feed/quote','/bist/feed/trend-universe','/bist/feed/ingest','/bist/feed/risk','/bist/feed/monitor','/bist/feed/report','/bist/feed/finalize','/bist/feed/daily','/bist/feed/audit','/bist/feed/probe','/bist/feed/gemini'].includes(u.pathname)){
  if(u.pathname==='/bist/feed/gemini'?!['GET','POST'].includes(request.method):['/bist/feed/monitor','/bist/feed/daily','/bist/feed/trend-universe'].includes(u.pathname)?request.method!=='GET':request.method!=='POST')return reply({error:'METHOD_NOT_ALLOWED'},405);
  const ingestToken=env.BIST_INGEST_TOKEN||env.ACCESS_TOKEN;
  if(!ingestToken)return reply({error:'INGEST_TOKEN_NOT_CONFIGURED'},503);
  if(!provided || !await secureEqual(provided,ingestToken))return reply({error:'Unauthorized'},401);
  try{if(u.pathname.endsWith('/trend-universe'))return await trendUniverse(env.DB);
   if(u.pathname.endsWith('/quote'))return await quoteIngest(request,env);
   if(u.pathname.endsWith('/trend'))return await trendIngest(request,env);
   if(u.pathname.endsWith('/gemini'))return await geminiDecision(request,env);
   if(u.pathname.endsWith('/probe'))return await probeMini(env);
   if(u.pathname.endsWith('/daily'))return reply(await dailyReport(env.DB));
   if(u.pathname.endsWith('/audit'))return await externalAudit(request,env);
   if(u.pathname.endsWith('/monitor'))return await monitorSymbols(env);
   if(u.pathname.endsWith('/risk'))return await riskIngest(request,env);
   if(u.pathname.endsWith('/report'))return await reportIngest(request,env);
   if(u.pathname.endsWith('/finalize'))return await finalize(request,env);
   return await ingest(request,env);}catch{return reply({error:'INGEST_OR_ENGINE_FAILED',retry_safe:true},503);}
 }
 if(!authenticated)return reply({error:"Unauthorized"},401);
 if(u.pathname.startsWith('/push/')){if(request.method==='POST'&&request.headers.get('Origin')&&request.headers.get('Origin')!==u.origin)return reply({error:'INVALID_ORIGIN'},403);return await pushRoute(request,env);}

 if(u.pathname==='/bist/status'||u.pathname==='/bist/bridge/status')return reply(await feedStatus(env.DB));
 if(u.pathname==='/bist/connections')return reply({mode:'CLOUD_BRIDGE_AI_REFEREE',external_fetch_enabled:true,market_data_fetch_enabled:false,gemini:await geminiStatus(env),openai:await aiStatus(env)});
 if(u.pathname==='/bist/ai/decisions')return reply({decisions:(await env.DB.prepare('SELECT symbol,bar_time,model,status,reason,completed_at,confidence,input_tokens,output_tokens FROM bist_ai_decisions ORDER BY created_at DESC LIMIT 100').all()).results});
 if(u.pathname==='/bist/report'){const report=await dailyReport(env.DB);const audit=await env.DB.prepare('SELECT * FROM bist_external_audits ORDER BY trt_date DESC LIMIT 1').first();return reply({...report,external_audit:audit?{...audit,report:JSON.parse(audit.report_json)}:null});}
 if(u.pathname==='/bist/overview')return reply({...await isolatedOverview(env.DB),gemini:await geminiStatus(env)});
 if(u.pathname==='/bist/strategy/berker3'){if(request.method==='POST'&&request.headers.get('Origin')&&request.headers.get('Origin')!==u.origin)return reply({error:'INVALID_ORIGIN'},403);try{return await berker3Route(request,env);}catch{return reply({error:'LIST_UPDATE_FAILED'},503);}}
 if(u.pathname==='/bist/strategy/close'){
  if(request.method!=='POST')return reply({error:'METHOD_NOT_ALLOWED'},405);
  if(request.headers.get('Origin')&&request.headers.get('Origin')!==u.origin)return reply({error:'INVALID_ORIGIN'},403);
  try{return await manualStrategyClose(request,env);}catch{return reply({error:'CLOSE_FAILED',retry_safe:true},503);}
 }
 return reply({error:'DISABLED_IN_INGRESS_ONLY_MODE',external_fetch_enabled:false},410);
},async scheduled(controller,env){const result=await enforceSessionClose(env.DB,Date.now());try{return {...result,push:await drainPush(env)};}catch{return {...result,push:{error:'DISPATCH_FAILED'}};}}};
