import {json,validSymbol,trtParts,trtDate,sessionOpen,entryPlan,restrictionClear,symbolBars,technicalSignal,feedStatus,GEMINI_MODEL} from './cloud_bridge.mjs';
const iso=n=>new Date(n).toISOString();
const QUEUES={SCALP:'scalp_sniper_queue',SWING:'trend_radar_queue'};
export function strategyEntryWindow(strategy,now){const p=trtParts(now),m=+p.hour*60+ +p.minute;return sessionOpen(now)&&m<(strategy==='SCALP'?1060:1080);}
export function usableQuote(q,now){return !!q&&q.source==='YAHOO_INDICATIVE'&&Number.isFinite(q.price)&&q.price>0&&Date.parse(q.quote_time)<=now&&now-Date.parse(q.quote_time)<=1200000&&trtDate(Date.parse(q.quote_time))===trtDate(now)&&sessionOpen(now);}
export async function saveQuote(db,symbol,q,now){
 if(!validSymbol(symbol)||!q||q.symbol!==symbol||!usableQuote(q,now))return false;
 await db.prepare(`INSERT INTO strategy_quotes(symbol,price,quote_time,received_at,source) VALUES(?,?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET price=excluded.price,quote_time=excluded.quote_time,received_at=excluded.received_at WHERE excluded.quote_time>=strategy_quotes.quote_time`).bind(symbol,q.price,q.quote_time,iso(now),q.source).run();return true;
}
export function ema(values,period=200){if(values.length<period)return null;let e=values.slice(0,period).reduce((a,b)=>a+b,0)/period;for(const p of values.slice(period))e=p*2/(period+1)+e*(1-2/(period+1));return e;}
export function superTrend(bars,period=10,multiplier=3){
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
export function trendSignal(hour,daily,intraday,now){
 const h=hour.at(-1),d=daily.at(-1);if(!h||!d||hour.length<200||daily.length<200||now-(Date.parse(h.bar_time)+3600000)>90*60000||Date.parse(h.bar_time)+3600000>now||now-Date.parse(d.bar_time)>5*86400000)return null;
 const eh=ema(hour.map(x=>x.close)),ed=ema(daily.map(x=>x.close)),sh=superTrend(hour),sd=superTrend(daily);
 const session=intraday.filter(b=>trtDate(Date.parse(b.bar_time))===trtDate(now)),volume=session.reduce((s,b)=>s+b.volume,0),vwap=volume?session.reduce((s,b)=>s+(b.high+b.low+b.close)/3*b.volume,0)/volume:null;
 if(!eh||!ed||!sh?.green||!sd?.green||!vwap||h.close<=eh||d.close<=ed||h.close<=vwap||sh.stop<=0||sh.stop>=h.close)return null;
 return {ema200_hour:eh,ema200_daily:ed,supertrend_hour:sh,supertrend_daily:sd,vwap,initial_stop:sh.stop,score:100*(h.close/eh-1)+100*(d.close/ed-1),bar_time:h.bar_time};
}
export function strategyThresholds(t){const unit=t.executed_price+t.commission/t.lot_count;return {breakeven:unit/(.998*.998),tp:unit*(t.strategy==='SCALP'?1.03:1.04)/(.998*.998),sl:unit*.985/(.998*.998)};}
export async function sellLeg(db,t,qty,raw,reason,quoteTime,now,activationTime=null){
 if(!Number.isInteger(qty)||qty<=0||!Number.isFinite(raw)||raw<=0)return false;
 const price=raw*.998,fee=price*qty*.002,pnl=price*qty-fee-(t.executed_price+t.commission/t.lot_count)*qty;
 const key=t.id+':'+(reason==='TREND_TP1'?'TP1':reason==='SCALP_TP1'?'SCALP_TP1':'FINAL');
 const r=await db.prepare(`INSERT OR IGNORE INTO strategy_exit_legs(event_key,trade_id,strategy,symbol,qty,executed_price,commission,exit_time,quote_time,observed_at,reason,pnl_net,activation_time) SELECT ?,id,strategy,symbol,?,?,?,?,?,?,?,?,? FROM virtual_trades WHERE id=? AND status='OPEN' AND remaining_lots=? AND tp1_done=?`).bind(key,qty,price,fee,iso(now),quoteTime,iso(now),reason,pnl,activationTime,t.id,t.remaining_lots,t.tp1_done).run();return r.meta.changes>0;
}
export function scalpExit(t,bars,q,now){
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
export async function manageScalp(db,now){const rows=await db.prepare("SELECT * FROM virtual_trades WHERE strategy='SCALP' AND status='OPEN' AND engine_version=2").all();let closed=0,partial=0;
 for(let t of rows.results||[]){const q=await db.prepare('SELECT * FROM strategy_quotes WHERE symbol=?').bind(t.symbol).first(),bars=await symbolBars(db,t.symbol,now);
  // A historical TP1 and a later runner exit may be observed in one monitor tick.
  for(let step=0;step<2;step++){const exit=scalpExit(t,bars,q,now);if(!exit||!await sellLeg(db,t,exit.qty??t.remaining_lots,exit.raw,exit.reason,exit.time,now,exit.activation||null))break;
   if(exit.reason!=='SCALP_TP1'){closed++;break;}partial++;t=await db.prepare('SELECT * FROM virtual_trades WHERE id=?').bind(t.id).first();
  }
 }return {closed,partial};
}
export async function trendHistories(db,symbol,now){const r=await db.prepare('SELECT * FROM trend_bars WHERE symbol=? AND bar_time<=? ORDER BY bar_time').bind(symbol,iso(now)).all();return {hour:(r.results||[]).filter(b=>b.interval==='60m'&&Date.parse(b.bar_time)+3600000<=now).slice(-350),daily:(r.results||[]).filter(b=>b.interval==='1d'&&trtDate(Date.parse(b.bar_time))<trtDate(now)).slice(-350)};}
export async function manageTrend(db,now){const rows=await db.prepare("SELECT * FROM virtual_trades WHERE strategy='SWING' AND status='OPEN' AND engine_version=2").all();let closed=0,partial=0;
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
export async function fillStrategy(db,strategy,now){const table=QUEUES[strategy];if(!table)throw Error('UNKNOWN_STRATEGY');let opened=0;
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
export async function tickStrategies(db,now=Date.now()){
 const scalp=await manageScalp(db,now),trend=await manageTrend(db,now),scalpFill=await fillStrategy(db,'SCALP',now),trendFill=await fillStrategy(db,'SWING',now);
 return {scalp:{...scalp,...scalpFill},trend:{...trend,...trendFill},paper_only:true};
}
export async function enqueueScalp(db,c,decision,observed){
 const stamp=iso(observed),expiry=iso(observed+900000);
 await db.batch([db.prepare("UPDATE scalp_sniper_queue SET status='EXPIRED',reason='SUPERSEDED' WHERE symbol=? AND status='READY' AND signal_key<>?").bind(c.symbol,decision.signal_key),db.prepare(`INSERT OR IGNORE INTO scalp_sniper_queue VALUES(?,?,?,?,?,?,'READY','TWO_AI_APPROVED',?)`).bind(decision.signal_key,c.symbol,c.bar_time,stamp,expiry,c.score,c.metrics_json)]);
 return await fillStrategy(db,'SCALP',observed);
}
async function boundedBody(request){if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw Error('JSON_REQUIRED');const reader=request.body?.getReader();if(!reader)throw Error('EMPTY_BODY');let n=0,s='';const decoder=new TextDecoder();while(true){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>200000){await reader.cancel();throw Error('PAYLOAD_TOO_LARGE');}s+=decoder.decode(value,{stream:true});}return JSON.parse(s+decoder.decode());}
export function validateTrendBars(symbol,interval,rows,now){
 if(!validSymbol(symbol)||!['60m','1d'].includes(interval)||!Array.isArray(rows)||!rows.length||rows.length>350)throw Error('INVALID_TREND_BARS');const seen=new Set();
 return rows.map(b=>{const t=Date.parse(b.time),v=[b.open,b.high,b.low,b.close,b.volume];if(typeof b.time!=='string'||!b.time.endsWith('Z')||!Number.isFinite(t)||t>now||t<now-800*86400000||!v.every(x=>typeof x==='number'&&Number.isFinite(x))||Math.min(...v.slice(0,4))<=0||b.volume<0||b.low>Math.min(b.open,b.close)||b.high<Math.max(b.open,b.close)||interval==='60m'&&(![0,1800000].includes(t%3600000)||t+3600000>now)||interval==='1d'&&trtDate(t)>=trtDate(now)||seen.has(t))throw Error('INVALID_TREND_BAR');seen.add(t);return {...b,symbol,interval,time:iso(t)};}).sort((a,b)=>a.time.localeCompare(b.time));
}
export async function trendIngest(request,env,now=Date.now()){
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
export async function strategyMonitor(db,now=Date.now()){
 const r=await db.prepare(`SELECT symbol,strategy FROM virtual_trades WHERE status='OPEN' UNION SELECT symbol,'SCALP' FROM scalp_sniper_queue WHERE status='READY' AND expires_at>? UNION SELECT symbol,'SWING' FROM trend_radar_queue WHERE status='READY' AND expires_at>?`).bind(iso(now),iso(now)).all();const targets=r.results||[];return {symbols:[...new Set(targets.map(x=>x.symbol))],targets};
}
export async function manualStrategyClose(request,env,now=Date.now()){
 const b=await boundedBody(request);if(!Number.isInteger(b.trade_id)||!['SCALP','SWING'].includes(b.strategy))return json({error:'INVALID_TRADE'},422);
 const t=await env.DB.prepare("SELECT * FROM virtual_trades WHERE id=? AND strategy=? AND status='OPEN' AND engine_version=2").bind(b.trade_id,b.strategy).first();if(!t)return json({error:'TRADE_NOT_OPEN'},409);
 const q=await env.DB.prepare('SELECT * FROM strategy_quotes WHERE symbol=?').bind(t.symbol).first();if(!usableQuote(q,now)||Date.parse(q.quote_time)<Date.parse(t.entry_time))return json({error:'FRESH_QUOTE_REQUIRED'},409);
 const closed=await sellLeg(env.DB,t,t.remaining_lots,q.price,'MANUAL_CLOSE',q.quote_time,now);
 return json({ok:closed,refill:await fillStrategy(env.DB,t.strategy,now),paper_only:true});
}
export async function isolatedOverview(db,now=Date.now()){
 const [status,cash,open,legs,old,scalp,trend]=await Promise.all([feedStatus(db,now),db.prepare('SELECT * FROM paper_cash_accounts').all(),db.prepare(`SELECT t.*,q.price current_price,q.quote_time FROM virtual_trades t LEFT JOIN strategy_quotes q ON q.symbol=t.symbol WHERE t.status='OPEN' ORDER BY t.strategy,t.slot_id`).all(),db.prepare('SELECT * FROM strategy_exit_legs ORDER BY observed_at DESC LIMIT 200').all(),db.prepare("SELECT id, strategy,symbol,lot_count qty,exit_price executed_price,exit_time,exit_reason reason,pnl_net FROM virtual_trades WHERE status='CLOSED' AND engine_version=1 ORDER BY exit_time DESC LIMIT 100").all(),db.prepare("SELECT s.*,q.price indicative_price,q.quote_time FROM scalp_sniper_queue s LEFT JOIN strategy_quotes q ON q.symbol=s.symbol WHERE s.status='READY' AND s.expires_at>? ORDER BY s.score DESC").bind(iso(now)).all(),db.prepare("SELECT * FROM trend_radar_queue WHERE status='READY' AND expires_at>? ORDER BY priority DESC,score DESC").bind(iso(now)).all()]);
 const [ai,watch,counts]=await Promise.all([
 db.prepare("SELECT d.symbol,d.bar_time,d.completed_at,d.confidence,d.reason,COALESCE(q.status,s.status) signal_status,COALESCE(q.expires_at,s.expires_at) expires_at,t.strategy,t.status trade_status,t.executed_price,t.lot_count,t.remaining_lots,t.entry_time,t.exit_time,t.pnl_net FROM bist_ai_decisions d LEFT JOIN scalp_sniper_queue q ON q.signal_key=d.signal_key LEFT JOIN bist_feed_signals s ON s.signal_key=d.signal_key LEFT JOIN virtual_trades t ON t.feed_entry_key=d.signal_key OR t.feed_entry_key='SCALP:'||d.signal_key OR t.feed_entry_key='SNIPER:'||d.signal_key WHERE d.status='APPROVED' AND date(d.completed_at,'+3 hours')=? ORDER BY d.completed_at DESC LIMIT 100").bind(trtDate(now)).all(),
 db.prepare("SELECT c.symbol,'CLOUD_FEED' source,'SCALP' strategy,0 verified,c.observed_at created_at,d.status ai_status FROM bist_funnel_candidates c LEFT JOIN bist_ai_decisions d ON d.signal_key=c.symbol||':'||c.bar_time WHERE c.run_id=(SELECT run_id FROM bist_funnel_reports ORDER BY completed_at DESC LIMIT 1) ORDER BY c.score DESC LIMIT 100").all(),
 db.prepare("SELECT count(DISTINCT symbol) approved FROM bist_ai_decisions WHERE status='APPROVED' AND date(completed_at,'+3 hours')=?").bind(trtDate(now)).first()]);
 const accounts=Object.fromEntries((cash.results||[]).map(x=>[x.strategy,x.available_cash])),trades=(open.results||[]).map(t=>{const qty=t.remaining_lots??t.lot_count,unit=t.executed_price+t.commission/t.lot_count,price=t.current_price||t.executed_price;const q={price,quote_time:t.quote_time,source:'YAHOO_INDICATIVE'};return {...t,remaining_lots:qty,current_price:price,quote_fresh:usableQuote(q,now),quote_age_minutes:t.quote_time?Math.max(0,(now-Date.parse(t.quote_time))/60000):null,unrealised_net:price*qty*.998*.998-unit*qty,unrealised_pct:100*(price*.998*.998/unit-1),elapsed_minutes:Math.max(0,(now-Date.parse(t.entry_time))/60000),runner_active: t.strategy==='SCALP'&&!!t.tp1_done,remaining_minutes:Math.max(0,((t.strategy==='SCALP'&&t.tp1_done?Date.parse(trtDate(Date.parse(t.entry_time))+'T14:40:00.000Z'):Date.parse(t.entry_time)+3600000)-now)/60000),thresholds:strategyThresholds(t)};});
 const histories=[...(legs.results||[]),...(old.results||[]).map(t=>({...t,event_key:'legacy:'+t.id,observed_at:t.exit_time}))].sort((a,b)=>String(b.observed_at).localeCompare(String(a.observed_at)));
 const realised=await db.prepare("SELECT (SELECT COALESCE(SUM(pnl_net),0) FROM strategy_exit_legs)+(SELECT COALESCE(SUM(pnl_net),0) FROM virtual_trades WHERE status='CLOSED' AND engine_version=1) pnl").first();
 return {...status,ai_signals:ai.results||[],watchlist:watch.results||[],approved:counts?.approved||0,candidates:status.stage1_hot||0,pending_entries:(scalp.results||[]).length+(trend.results||[]).length,total_capital:5000,equity:(accounts.SCALP||0)+(accounts.SWING||0)+trades.reduce((n,t)=>n+t.current_price*t.remaining_lots*.998*.998,0),equity_basis:'LAST_AVAILABLE_QUOTE_NET_LIQUIDATION_ESTIMATE',realised_pnl:realised?.pnl||0,scalp_cash:accounts.SCALP||0,swing_cash:accounts.SWING||0,open_trades:trades,exit_history:histories,closed_trades:histories,scalp_sniper_queue:scalp.results||[],trend_radar_queue:trend.results||[],scalp_slots:trades.filter(t=>t.strategy==='SCALP').length,trend_slots:trades.filter(t=>t.strategy==='SWING').length,engine_version:2};
}
export async function quoteIngest(request,env,now=Date.now()){
 let b;try{b=await boundedBody(request);}catch(e){return json({error:e.message},422);}
 if(!await saveQuote(env.DB,b.symbol,b.quote,now))return json({error:'FRESH_PROVIDER_QUOTE_REQUIRED'},422);
 return json({ok:true,engines:await tickStrategies(env.DB,now)});
}
export async function trendUniverse(db,now=Date.now()){const r=await db.prepare(`SELECT symbol FROM bist_universe WHERE active=1 UNION SELECT symbol FROM bist_funnel_risk WHERE eligible=1 AND valid_until>? UNION SELECT symbol FROM berker3_symbols WHERE active=1`).bind(iso(now)).all();const p=await db.prepare('SELECT symbol FROM berker3_symbols WHERE active=1 ORDER BY priority DESC,symbol').all();return json({symbols:(r.results||[]).map(x=>x.symbol),priority:(p.results||[]).map(x=>x.symbol)});}
export async function berker3Route(request,env){
 if(request.method==='GET'){const r=await env.DB.prepare('SELECT symbol FROM berker3_symbols WHERE active=1 ORDER BY priority DESC,symbol').all();return json({symbols:(r.results||[]).map(x=>x.symbol)});}
 if(request.method!=='POST')return json({error:'METHOD_NOT_ALLOWED'},405);
 const b=await boundedBody(request);if(!Array.isArray(b.symbols)||b.symbols.length>100||!b.symbols.every(validSymbol)||new Set(b.symbols).size!==b.symbols.length)return json({error:'INVALID_SYMBOLS'},422);
 await env.DB.batch([env.DB.prepare('UPDATE berker3_symbols SET active=0'),...b.symbols.map(symbol=>env.DB.prepare('INSERT INTO berker3_symbols(symbol,priority,active) VALUES(?,1,1) ON CONFLICT(symbol) DO UPDATE SET active=1,priority=1').bind(symbol)),env.DB.prepare('UPDATE trend_radar_queue SET priority=COALESCE((SELECT priority FROM berker3_symbols b WHERE b.symbol=trend_radar_queue.symbol AND b.active=1),0)')]);return json({ok:true,symbols:b.symbols});
}
