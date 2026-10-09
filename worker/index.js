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
   body:JSON.stringify({model:AI_MODEL,temperature:0,max_com…12810 tokens truncated…,headers:{'Content-Type':'application/json'},body:JSON.stringify({trade_id:t.id,strategy:t.strategy})});const x=await r.json();if(!r.ok)throw Error(x.error==='FRESH_QUOTE_REQUIRED'?'Taze fiyat bekleniyor.':'Kapatma başarısız; paneli yenile.');await refresh();}catch(e){button.textContent=e.message;button.disabled=false;}};card.append(button);box.append(card);}
 if(!trades.length)empty(box,'İki slot da boş; uygun aday bekleniyor.');
}
function renderQueue(id,rows,trend){const box=el(id);box.replaceChildren();for(const [i,q] of rows.entries()){const n=node('div',null,'queue');n.append(node('b',(i+1)+'. '+q.symbol+(trend&&q.priority?' · berker3':'')),node('p','Puan '+q.score.toFixed(2)+' · '+q.reason),node('small','Son geçerlilik: '+stamp(q.expires_at)));box.append(n);}if(!rows.length)empty(box,'Hazır yedek yok.');}
function renderHistory(){const box=el('historyRows');box.replaceChildren();for(const t of (data.exit_history||[]).filter(t=>filter==='ALL'||t.strategy===filter)){const n=node('article',null,'history');n.append(node('b',t.symbol+' · '+(t.strategy==='SCALP'?'Scalp':'Trend')+' · '+t.qty+' lot'),node('p',reasons[t.reason]||t.reason),node('span',money(t.pnl_net),t.pnl_net>=0?'gain':'loss'),node('p','Satış '+price(t.executed_price)+' TL · '+stamp(t.observed_at||t.exit_time),'muted'));box.append(n);}if(!box.children.length)empty(box,'Bu filtrede satış kaydı yok.');}
function timers(){document.querySelectorAll('[data-entry]').forEach(n=>{const mins=Math.max(0,(clock()-Date.parse(n.dataset.entry))/60000),remain=Math.max(0,60-mins);n.textContent=Math.floor(mins)+'/60 dk · Kalan '+Math.ceil(remain)+' dk'+(remain===0?' · Çıkış fiyatı bekleniyor':'');});}
function render(){el('capital').textContent=money(data.total_capital);el('equity').textContent=money(data.equity);el('realised').textContent=money(data.realised_pnl);el('scalpCash').textContent=money(data.scalp_cash)+' boş nakit · '+data.scalp_slots+'/2 dolu slot';el('trendCash').textContent=money(data.swing_cash)+' boş nakit · '+data.trend_slots+'/2 dolu slot';el('connection').textContent=data.scanner_live?'Veri aktif':'Veri bekleniyor';el('freshness').textContent='Panel '+stamp(data.server_time)+' · Son tam tarama '+stamp(data.last_scan_at)+' · '+data.last_scan_fetched+' hisse';renderOpen('scalpOpen','SCALP');renderOpen('trendOpen','SWING');renderQueue('scalpQueue',data.scalp_sniper_queue||[],false);renderQueue('trendQueue',data.trend_radar_queue||[],true);renderHistory();timers();}
async function refresh(){if(loading)return;loading=true;try{const r=await fetch('/bist/overview');if(!r.ok)throw Error(r.status===401?'Ayarlar bölümünden giriş yap.':'Panel güncellenemedi.');data=await r.json();offset=Date.parse(data.server_time)-Date.now();render();el('loginStatus').textContent='Bağlantı hazır.';}catch(e){el('freshness').textContent=e.message+' Son gösterilen kayıtlar güncel olmayabilir.';}finally{loading=false;}}
el('login').onclick=async()=>{const token=el('token').value.trim();try{if(token){const r=await fetch('/bist/session',{method:'POST',headers:{Authorization:'Bearer '+token}});if(!r.ok)throw Error('Erişim tokenı hatalı.');el('token').value='';}await refresh();await loadSettings();}catch(e){el('loginStatus').textContent=e.message;}};
async function loadSettings(){try{const r=await fetch('/bist/connections');if(r.ok){const d=await r.json();el('aiStatus').textContent='Scalp AI: Gemini '+d.gemini.connection+' · GPT '+d.openai.connection+' | Trend: EMA200 / SüperTrend / VWAP sayısal onayı';}const b=await fetch('/bist/strategy/berker3');if(b.ok&&!el('berker3').matches(':focus'))el('berker3').value=(await b.json()).symbols.join(', ');}catch{}}
el('saveBerker3').onclick=async()=>{try{const symbols=[...new Set(el('berker3').value.toUpperCase().split(/[\s,;]+/).filter(Boolean))];const r=await fetch('/bist/strategy/berker3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbols})});if(!r.ok)throw Error('Liste kaydedilemedi; sembolleri kontrol et.');el('berker3Status').textContent='Öncelik listesi kaydedildi; sinyal kuralları her hisse için geçerli.';}catch(e){el('berker3Status').textContent=e.message;}};
el('filters').querySelectorAll('button').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;el('filters').querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));if(data)renderHistory();});
el('copyReport').onclick=async()=>{if(!data)return;const text='BIST AVCI sanal işlem karnesi\n'+JSON.stringify(data,null,2);el('report').value=text;try{await navigator.clipboard.writeText(text);el('reportStatus').textContent='Kopyalandı.';}catch{el('report').focus();el('report').select();el('reportStatus').textContent='Metin seçildi; Kopyala seçebilirsin.';}};
async function testPush(){try{if(!('serviceWorker'in navigator)||!('PushManager'in window))throw Error('Paneli ana ekrandan açıp bildirimleri etkinleştir.');const reg=await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Sayfayı yenileyip tekrar dene.')),20000))]);const sub=await reg.pushManager.getSubscription();if(!sub)throw Error('Önce bildirimleri etkinleştir.');const r=await fetch('/push/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:sub.endpoint})});const x=await r.json();if(!r.ok||!x.accepted)throw Error('Test gönderilemedi; bildirimleri yeniden etkinleştir.');el('pushStatus').textContent='Test bildirim servisine iletildi. Telefonda görünmüyorsa bildirim ve Odak ayarlarını kontrol et.';}catch(e){el('pushStatus').textContent=e.message;}}
el('pushTest').onclick=testPush;
el('pushOn').onclick=async()=>{try{if(!('Notification'in window)||!('PushManager'in window))throw Error('Safari → Paylaş → Ana Ekrana Ekle; paneli ana ekrandan aç.');if(await Notification.requestPermission()!=='granted')throw Error('Bildirim izni verilmedi. iPhone bildirim ayarlarını kontrol et.');await navigator.serviceWorker.register('/sw.js');const reg=await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Sayfayı yenileyip tekrar dene.')),20000))]);const r=await fetch('/push/key');if(!r.ok)throw Error('Bildirim servisi hazır değil; panel girişini kontrol et.');const x=await r.json(),base=x.key.replace(/-/g,'+').replace(/_/g,'/'),key=Uint8Array.from(atob(base.padEnd(Math.ceil(base.length/4)*4,'=')),c=>c.charCodeAt(0));let sub=await reg.pushManager.getSubscription();if(sub?.options.applicationServerKey){const prev=new Uint8Array(sub.options.applicationServerKey);if(prev.length!==key.length||prev.some((v,i)=>v!==key[i])){await sub.unsubscribe();sub=null;}}sub=sub||await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});const saved=await fetch('/push/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sub)});if(!saved.ok)throw Error('Abonelik kaydedilemedi.');await testPush();}catch(e){el('pushStatus').textContent=e.message;}};
if('serviceWorker'in navigator)void navigator.serviceWorker.register('/sw.js').catch(()=>{});void refresh();void loadSettings();setInterval(()=>{if(!document.hidden)void refresh();},5000);setInterval(()=>{if(!document.hidden)timers();},1000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
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
