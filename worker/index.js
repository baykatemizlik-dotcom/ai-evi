// Market data is ingress-only. The only outbound request is the OpenAI paper referee.
const validSymbol = symbol => typeof symbol==='string' && /^[A-Z0-9]{3,6}$/.test(symbol);
const FRESH_MS = 35 * 60000;
const json = (body, status=200) => new Response(JSON.stringify(body), {
 status, headers: {'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}
});
function sessionOpen(now) {
 const d = new Date(now+3*3600000), minutes = d.getUTCHours()*60+d.getUTCMinutes();
 return d.getUTCDay()>0 && d.getUTCDay()<6 && minutes>=600 && minutes<=1095;
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
function stageOneMetrics(bars) {
 if(bars.length<21)return null;
 const b=bars.at(-1),prev=bars.slice(-21,-1);
 const avg=prev.reduce((sum,x)=>sum+x.volume,0)/20,spread=b.high-b.low+1e-9;
 const rvol=avg>0?b.volume/avg:0,body=Math.abs(b.close-b.open)/spread,upper_wick=(b.high-b.close)/spread;
 return rvol>=2 && b.close>b.open && body>=.60 && upper_wick<=.20 ? {rvol,body,upper_wick}:null;
}
function technicalSignal(bars) {
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
async function runPaper(db, symbol, now) {
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
 if(entryWindow(now) && !await db.prepare('SELECT trt_date FROM bist_session_lock WHERE trt_date=?').bind(trtDate(now)).first() && pending && await restrictionClear(db,symbol,now) && await db.prepare("SELECT signal_key FROM bist_ai_decisions WHERE signal_key=? AND status='APPROVED' AND model='gpt-4o-mini'").bind(pending.signal_key).first()){
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
function entryWindow(now) {
 const trt=new Date(now+10800000),minute=trt.getUTCHours()*60+trt.getUTCMinutes();
 return sessionOpen(now)&&minute<1075; // 17:55 TRT
}
function trtDate(now){return new Date(now+10800000).toISOString().slice(0,10);}
function sniperEntryPlan(cash,price){const executed=price*1.002,qty=Math.floor(cash/(executed*1.002));return {qty,executed,commission:executed*qty*.002};}
function initialSniperState(trade){
 const cost=trade.executed_price*trade.lot_count+trade.commission;
 return {peak_price:trade.executed_price,stop_price:cost*.98/(trade.lot_count*.998*.998),last_peak_at:trade.entry_time,last_processed_bar:null,breakeven:0};
}
function sniperAdvance(trade,state,bars){
 const next={...state},cost=trade.executed_price*trade.lot_count+trade.commission;
 const breakPrice=cost/(trade.lot_count*.998*.998),armPrice=breakPrice*1.025;
 for(const b of bars){
  if(b.bar_time<trade.entry_time||next.last_processed_bar&&b.bar_time<=next.last_processed_bar)continue;
  const end=new Date(Date.parse(b.bar_time)+900000).toISOString();
  // Only the stop known at candle OPEN may execute in this candle.
  if(b.low<=next.stop_price){const raw=Math.min(b.open,next.stop_price),executed=raw*.998;
   return {state:next,exit:{executed,time:end,pnl:executed*trade.lot_count*.998-cost,reason:next.stop_price>initialSniperState(trade).stop_price+1e-8?(Math.abs(next.stop_price-breakPrice)<1e-8?'SNIPER_BREAKEVEN':'SNIPER_TRAILING_STOP_2_PCT'):'SNIPER_BASE_STOP_NET_2_PCT',quote_time:b.bar_time}};}
  if(b.high>next.peak_price){next.peak_price=b.high;next.last_peak_at=end;}
  if(next.peak_price>=armPrice)next.breakeven=1;
  next.stop_price=Math.max(next.stop_price,next.peak_price*.98,next.breakeven?breakPrice:0);
  next.last_processed_bar=b.bar_time;
  if(Date.parse(end)-Date.parse(next.last_peak_at)>=3600000){const executed=b.close*.998;
   return {state:next,exit:{executed,time:end,pnl:executed*trade.lot_count*.998-cost,reason:'SNIPER_NO_NEW_HIGH_60_MIN',quote_time:b.bar_time}};}
 }
 return {state:next,exit:null};
}
async function symbolBars(db,symbol){return (await db.prepare("SELECT * FROM bist_bridge_bars WHERE symbol=? AND interval='15m' AND source='YAHOO_INDICATIVE' AND CAST(strftime('%s',bar_time) AS INTEGER)%900=0 ORDER BY bar_time DESC LIMIT 100").bind(symbol).all()).results.reverse();}
async function closePaper(db,trade,exit){return !!await db.prepare("UPDATE virtual_trades SET status='CLOSED',exit_price=?,exit_time=?,pnl_net=?,exit_reason=? WHERE id=? AND status='OPEN' RETURNING id").bind(exit.executed,exit.time,exit.pnl,exit.reason,trade.id).first();}
async function processSniper(db,trade,bars,now){
 let state=await db.prepare('SELECT * FROM bist_sniper_state WHERE trade_id=?').bind(trade.id).first();
 if(!state){const initial=initialSniperState(trade);await db.prepare('INSERT OR IGNORE INTO bist_sniper_state(trade_id,peak_price,stop_price,last_peak_at,breakeven) VALUES(?,?,?,?,0)').bind(trade.id,initial.peak_price,initial.stop_price,initial.last_peak_at).run();state=await db.prepare('SELECT * FROM bist_sniper_state WHERE trade_id=?').bind(trade.id).first();}
 const outcome=sniperAdvance(trade,state,bars),s=outcome.state;
 if(outcome.exit&&await closePaper(db,trade,outcome.exit)){
  await db.prepare('UPDATE bist_sniper_state SET quote_time=?,last_exit_note=?,exit_observed_at=? WHERE trade_id=?').bind(outcome.exit.quote_time,outcome.exit.reason,new Date(now).toISOString(),trade.id).run();return 1;
 }
 // A concurrent retry with an older bar must not roll back the high-water mark.
 await db.prepare(`UPDATE bist_sniper_state SET peak_price=?,stop_price=?,last_peak_at=?,last_processed_bar=?,breakeven=? WHERE trade_id=? AND (last_processed_bar IS NULL OR last_processed_bar<=?)`)
  .bind(s.peak_price,s.stop_price,s.last_peak_at,s.last_processed_bar,s.breakeven,trade.id,s.last_processed_bar).run();return 0;
}
async function refreshStandby(db,symbol,bars,now){
 const ready=await db.prepare("SELECT * FROM bist_sniper_queue WHERE symbol=? AND status='READY'").bind(symbol).all();
 const last=bars.at(-1);if(!last)return;
 const metrics=stageOneMetrics(bars),session=bars.filter(b=>b.bar_time.slice(0,10)===last.bar_time.slice(0,10));
 const volume=session.reduce((n,b)=>n+b.volume,0),vwap=volume?session.reduce((n,b)=>n+(b.high+b.low+b.close)/3*b.volume,0)/volume:0;
 for(const q of ready.results||[]){
  if(last.bar_time<=q.last_checked_bar)continue;
  const good=fresh({...last,feed_type:'INDICATIVE_INTRADAY'},now)&&metrics&&last.close>vwap&&await restrictionClear(db,symbol,now);
  await db.prepare("UPDATE bist_sniper_queue SET status=?,reason=?,last_checked_bar=?,last_checked_at=?,score=?,expires_at=? WHERE signal_key=? AND status='READY' AND last_checked_bar<?")
   .bind(good?'READY':'INVALID',good?'HEALTH_RECHECK_PASSED':'VWAP_CANDLE_VOLUME_OR_RISK_FAILED',last.bar_time,new Date(now).toISOString(),good?metrics.rvol+100*(last.close/vwap-1):q.score,new Date(now+3600000).toISOString(),q.signal_key,last.bar_time).run();
 }
}
async function runSniper(db,now){
 const result={opened:0,closed:0};
 const positions=await db.prepare("SELECT * FROM virtual_trades WHERE strategy='SWING' AND status='OPEN' AND feed_entry_key LIKE 'SNIPER:%'").all();
 for(const trade of positions.results||[]){const bars=await symbolBars(db,trade.symbol);if(bars.length&&fresh({...bars.at(-1),feed_type:'INDICATIVE_INTRADAY'},now))result.closed+=await processSniper(db,trade,bars,now);}
 if(!entryWindow(now)||await db.prepare('SELECT trt_date FROM bist_session_lock WHERE trt_date=?').bind(trtDate(now)).first())return result;
 if(await db.prepare("SELECT id FROM virtual_trades WHERE strategy='SWING' AND status='OPEN' LIMIT 1").first())return result;
 const queue=await db.prepare(`SELECT q.* FROM bist_sniper_queue q JOIN bist_funnel_risk r ON r.symbol=q.symbol
  WHERE q.status='READY' AND q.expires_at>=? AND r.eligible=1 AND r.valid_until>?
  AND NOT EXISTS(SELECT 1 FROM virtual_trades t WHERE t.status='OPEN' AND t.symbol=q.symbol)
  ORDER BY q.score DESC,q.confidence DESC,q.symbol ASC`).bind(new Date(now).toISOString(),new Date(now).toISOString()).all();
 for(const q of queue.results||[]){
  if(!await db.prepare("SELECT signal_key FROM bist_ai_decisions WHERE signal_key=? AND status='APPROVED'").bind(q.signal_key).first())continue;
  const latestExit=await db.prepare('SELECT MAX(exit_observed_at) t FROM bist_sniper_state').first();
  const bars=await symbolBars(db,q.symbol),observed=new Date(Math.max(Date.parse(q.observed_at),Date.parse(q.last_checked_at),Date.parse(latestExit?.t)||0)).toISOString();
  const next=eligibleEntryBar({...q,observed_at:observed},bars);
  if(!next||!entryWindow(Date.parse(next.bar_time)))break;
  if(!fresh({bar_time:q.last_checked_bar,feed_type:'INDICATIVE_INTRADAY'},Date.parse(next.bar_time)))continue;
  if(!fresh({...bars.at(-1),feed_type:'INDICATIVE_INTRADAY'},now))continue;
  const account=await db.prepare("SELECT available_cash FROM paper_cash_accounts WHERE strategy='SWING'").first(),plan=sniperEntryPlan(account?.available_cash||0,next.open);
  if(plan.qty<=0)break;
  try{const inserted=await db.prepare("INSERT INTO virtual_trades(strategy,symbol,signal_price,executed_price,lot_count,commission,entry_time,status,slot_id,feed_entry_key) VALUES('SWING',?,?,?,?,?,?,'OPEN',1,?) ON CONFLICT(feed_entry_key) DO NOTHING RETURNING id")
   .bind(q.symbol,next.open,plan.executed,plan.qty,plan.commission,next.bar_time,'SNIPER:'+q.signal_key).first();
   if(inserted){result.opened=1;const trade=await db.prepare('SELECT * FROM virtual_trades WHERE id=?').bind(inserted.id).first();result.closed+=await processSniper(db,trade,bars,now);}
  }catch(e){if(!/PAPER_SLOT_BUSY|PAPER_INSUFFICIENT_CASH|PAPER_SIGNAL_NOT_ELIGIBLE/.test(String(e)))throw e;}
  break;
 }
 return result;
}
async function enforceSessionClose(db,now=Date.now()){
 if(new Date(now+10800000).getUTCHours()*60+new Date(now+10800000).getUTCMinutes()<1075)return {closed:0};
 const stamp=new Date(now).toISOString();
 await db.batch([db.prepare('INSERT OR IGNORE INTO bist_session_lock(trt_date,locked_at) VALUES(?,?)').bind(trtDate(now),stamp),
  db.prepare("UPDATE bist_feed_signals SET status='EXPIRED' WHERE status='PENDING'"),db.prepare("UPDATE bist_sniper_queue SET status='EXPIRED',reason='SESSION_1755_LOCK' WHERE status='READY'")]);
 const positions=await db.prepare("SELECT * FROM virtual_trades WHERE status='OPEN' AND feed_entry_key IS NOT NULL").all();let closed=0;
 for(const trade of positions.results||[]){
  const rows=await symbolBars(db,trade.symbol),bar=rows.filter(b=>Date.parse(b.bar_time)+900000<=now).at(-1);if(!bar)continue;
  const executed=bar.close*.998,cost=trade.executed_price*trade.lot_count+trade.commission;
  const reason='SESSION_1755_INDICATIVE_LAST_CLOSED_BAR';
  if(await closePaper(db,trade,{executed,time:stamp,pnl:executed*trade.lot_count*.998-cost,reason})){closed++;
   if(trade.strategy==='SWING')await db.prepare('UPDATE bist_sniper_state SET quote_time=?,last_exit_note=? WHERE trade_id=?').bind(bar.bar_time,reason,trade.id).run();}
 }
 await dailyReport(db,now);return {closed,price_mode:'INDICATIVE_LAST_CLOSED_BAR'};
}
async function dailyReport(db,now=Date.now()){
 const date=trtDate(now),start=date+'T00:00:00',end=date+'T23:59:59';
 const [trades,ai,cash,queue]=await Promise.all([
  db.prepare("SELECT strategy,COUNT(*) trades,SUM(pnl_net) pnl,SUM(CASE WHEN pnl_net>0 THEN 1 ELSE 0 END) wins FROM virtual_trades WHERE status='CLOSED' AND datetime(exit_time,'+3 hours') BETWEEN ? AND ? GROUP BY strategy").bind(start.replace('T',' '),end.replace('T',' ')).all(),
  db.prepare("SELECT status,COUNT(*) n,SUM(input_tokens) input_tokens,SUM(output_tokens) output_tokens FROM bist_ai_decisions WHERE substr(datetime(created_at,'+3 hours'),1,10)=? GROUP BY status").bind(date).all(),
  db.prepare('SELECT strategy,available_cash FROM paper_cash_accounts').all(),db.prepare('SELECT status,COUNT(*) n FROM bist_sniper_queue GROUP BY status').all()]);
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
 const session=await enforceSessionClose(env.DB,now);
 const sniper=active?await runSniper(env.DB,now):{opened:0,closed:0};
 if(active)await refreshStandby(env.DB,symbol,await symbolBars(env.DB,symbol),now);
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
async function monitorSymbols(env,now=Date.now()) {
 const rows=await env.DB.prepare("SELECT symbol FROM virtual_trades WHERE strategy IN('SCALP','SWING') AND status='OPEN' UNION SELECT symbol FROM bist_feed_signals WHERE status='PENDING' AND expires_at>=? UNION SELECT symbol FROM bist_sniper_queue WHERE status='READY' AND expires_at>=?")
  .bind(new Date(now).toISOString(),new Date(now).toISOString()).all();return json({symbols:(rows.results||[]).map(x=>x.symbol)});
}
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
async function aiVerdict(env,candidate,risk,network=(...args)=>globalThis.fetch(...args)) {
 const apiKey=typeof env.OPENAI_API_KEY==='string'?env.OPENAI_API_KEY.trim():'';
 if(!apiKey)throw Error('OPENAI_KEY_MISSING');
 if(/[^\x21-\x7e]/.test(apiKey))throw Error('OPENAI_KEY_FORMAT_ERROR');
 const m=JSON.parse(candidate.metrics_json);
 if(!Number.isFinite(m.rvol)||m.rvol<2||!Number.isFinite(m.body)||m.body<.6||!Number.isFinite(m.upper_wick)||m.upper_wick>.2||risk?.eligible!==1||!m.last_candle||!(m.last_candle.close>m.last_candle.open&&m.last_candle.close>m.vwap&&m.last_candle.close>m.resistance))
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
  if(!entryWindow(observed)||!fresh({bar_time:c.bar_time,feed_type:'INDICATIVE_INTRADAY'},observed)||!await restrictionClear(env.DB,c.symbol,observed))continue;
  const result=await env.DB.prepare("INSERT OR IGNORE INTO bist_feed_signals(signal_key,symbol,bar_time,observed_at,expires_at,source,metrics_json) VALUES(?,?,?,?,?,'YAHOO_INDICATIVE',?)")
   .bind(decision.signal_key,c.symbol,c.bar_time,new Date(observed).toISOString(),new Date(observed+60*60000).toISOString(),c.metrics_json).run();created+=result.meta.changes;selected.push(c.symbol);
  await env.DB.batch([env.DB.prepare("UPDATE bist_sniper_queue SET status='EXPIRED',reason='SUPERSEDED_BY_NEW_APPROVAL' WHERE symbol=? AND status='READY' AND signal_key!=?").bind(c.symbol,decision.signal_key),
   env.DB.prepare("INSERT OR IGNORE INTO bist_sniper_queue(signal_key,symbol,bar_time,observed_at,expires_at,last_checked_bar,last_checked_at,score,confidence,status,reason,metrics_json) VALUES(?,?,?,?,?,?,?,?,?,'READY','MINI_APPROVED',?)")
    .bind(decision.signal_key,c.symbol,c.bar_time,new Date(observed).toISOString(),new Date(observed+3600000).toISOString(),c.bar_time,new Date(observed).toISOString(),c.score,decision.confidence||0,c.metrics_json)]);
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
 return {status:scanning?'ACTIVE':'BLOCKED_MARKET_DATA_UNAVAILABLE',scanner_live:scanning,
  active_symbols:active.length,scanned_symbols:valid.reduce((n,x)=>n+x.fetched,0),
  universe_total:scan[0]?.universe_total||0,eligible_total:scan[0]?.eligible_total||0,
  stage1_hot:scan.reduce((n,x)=>n+x.hot,0),shards_completed:scan.length,
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

const reply=json;
const hash=async value=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
const secureEqual=async(a,b)=>{const[x,y]=await Promise.all([hash(a),hash(b)]);let d=0;for(let i=0;i<x.length;i++)d|=x[i]^y[i];return d===0;};
export default {async fetch(request,env){
 const u=new URL(request.url);
 const dashboard=String.raw`<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0b1019"><meta name="referrer" content="no-referrer"><link rel="manifest" href="/manifest.json"><title>BIST AVCI</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0b1019;color:#f2f5fa;font:15px -apple-system,BlinkMacSystemFont,system-ui,sans-serif}main{max-width:720px;margin:auto;padding:20px 17px 100px}header{display:flex;justify-content:space-between;align-items:center;gap:8px}h1{font-size:25px;line-height:1.15;margin:0}h2{font-size:18px;margin:25px 0 12px}p{color:#aeb8c8;margin:5px 0 13px;line-height:1.45}.muted,small{color:#99a5b5;font-size:12px}.badge{border-radius:50px;padding:8px 12px;background:#26313f;color:#ced9e7;font-size:12px}.api{display:flex;gap:7px;flex-wrap:wrap;margin:19px 0}.pill{padding:9px 12px;border:1px solid #374459;border-radius:25px;font-size:12px;color:#ccd5e2;background:#151d2b}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#778394;margin-right:6px}.ok{background:#37d58c;box-shadow:0 0 7px #37d58c}.bad{background:#ff7070}.wait{background:#e6bc50}.panel,.tile{border:1px solid #2d3849;border-radius:17px;padding:17px;background:#151d2b}.hero{background:linear-gradient(125deg,#1c3345,#122332);border:1px solid #365165;border-radius:19px;padding:20px;margin-top:18px}.hero strong{font-size:32px;letter-spacing:-1px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.statgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:12px}.stat{background:#222b3a;border-radius:14px;padding:13px;text-align:center}.stat strong{font-size:23px;display:block}.stat small{font-size:12px}.money{font-size:23px;font-weight:750;margin-top:6px}.empty{padding:18px;border:1px solid #354356;border-radius:15px;color:#a7b5c6;background:#111925;line-height:1.5}.hrow{display:flex;justify-content:space-between;align-items:center;gap:10px}.hrow h2{margin:23px 0 12px}.tabs{display:flex;gap:8px;margin-bottom:12px}.tabs button{width:auto;border-radius:24px;padding:10px 16px;background:#263244}.tabs button.active{background:#32745f}.page{display:none}.page.active{display:block}.nav{position:fixed;z-index:5;bottom:0;left:0;right:0;padding:9px max(10px,env(safe-area-inset-left)) calc(8px + env(safe-area-inset-bottom));background:#111a28;border-top:1px solid #394252;display:flex;justify-content:space-around;gap:4px}.nav button{border:0;background:transparent;flex:1;min-width:0;padding:7px 0;color:#9daabd;font-size:11px;border-radius:10px}.nav button.active{color:#65dfab;background:#213348}.nav b{display:block;font-size:20px;margin-bottom:3px}button{cursor:pointer;border:1px solid #426477;border-radius:11px;padding:12px 14px;background:#226b59;color:white;font-size:14px;font-weight:650}button:disabled{opacity:.6}input{width:100%;background:#0b111c;border:1px solid #56647a;border-radius:11px;padding:14px;color:#fff;font-size:16px;margin:8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0a121e;border-radius:12px;padding:13px;color:#cdd9e7;font-size:12px;max-height:260px;overflow:auto}.warn{color:#e9c782}.subtle{border-top:1px solid #29374a;margin:19px 0 0}.chip{font-size:12px;border:1px solid #45617b;padding:5px 9px;border-radius:20px;color:#aecaee}.cards{display:grid;gap:9px}a{color:#81dccc}@media(min-width:700px){.nav{max-width:720px;margin:auto;border-left:1px solid #394252;border-right:1px solid #394252}}
</style></head><body><main>
<header><div><h1>📈 BIST AVCI</h1><p>Bulut radar & sanal portföy · teknik demo</p></div><span class="badge" id="mainState">Veri bekleniyor</span></header>
<div class="api"><span class="pill"><i id="geminiDot" class="dot"></i>Gemini · <span id="geminiText">Kontrol bekliyor</span></span><span class="pill"><i id="gptDot" class="dot"></i>GPT · <span id="gptText">Kontrol bekliyor</span></span></div>
<div id="home" class="page active">
<div class="hero"><small>💼 Toplam sanal portföy · başlangıç</small><div><strong id="total">5.000,00 TL</strong></div><p>Gerçekleşen kâr/zarar: <span id="pnl">Henüz işlem yok</span></p></div>
<div class="grid" style="margin-top:11px"><div class="tile"><b>⚡ SCALP</b><div class="money" id="scalpCash">2.500 TL</div><small>Gün içi al-sat kasası</small></div><div class="tile"><b>🎯 SNIPER</b><div class="money" id="swingCash">2.500 TL</div><small>Tek hisse · gün içi trend</small></div></div>
<div class="statgrid"><div class="stat"><strong id="scanned">0</strong><small>Taranan</small></div><div class="stat"><strong id="candidates">0</strong><small>👆 Adaylar</small></div><div class="stat"><strong id="approved">0</strong><small>Onaylı</small></div></div>
<div class="hrow"><h2>🎯 Günün İzleme Listesi</h2><small>09:15 bülteni</small></div><div class="empty" id="watchlist" role="button" tabindex="0" data-jump="candidates">Henüz doğrulanmış piyasa verisiyle liste oluşmadı.</div>
<div class="hrow"><h2>⚡ Canlı Radar</h2><small>15 dakikalık bulut döngüsü</small></div><div class="panel"><div class="hrow"><span>Piyasa veri kaynağı</span><span class="warn" id="marketState">Bağlantı bekleniyor</span></div><div class="hrow" style="margin-top:14px"><span>XU100 savunma</span><span class="warn" id="xuState">Veri bekleniyor</span></div><p class="muted" id="lastRun" style="margin-top:13px">Son tarama: bekleniyor</p></div>
<div class="hrow"><h2>✅ Onaylı Sinyaller</h2><small>En yeniler üstte</small></div><div class="tabs"><button class="active" data-filter="ALL">Tümü</button><button data-filter="SCALP">Günlük</button><button data-filter="SWING">Swing</button></div><div class="empty" id="signalsHome">Henüz onaylı AL / SAT sinyali yok.</div>
<h2>💼 Açık Demo İşlemler</h2><div class="empty" id="openHome">Henüz sanal işlem açılmadı.</div><h2>📊 Performans</h2><div class="empty" id="performanceHome">Gerçek fiyatlarla kapanan sanal işlemler burada gösterilecek.</div>
</div>
<div id="candidates" class="page"><h2>🎯 Pusudaki Adaylar</h2><div class="tabs"><button class="active" data-candidate-filter="ALL">Tümü</button><button data-candidate-filter="SCALP">⚡ Scalp</button><button data-candidate-filter="SWING">📈 Swing</button><button data-candidate-filter="WHALE">🐋 Balina</button></div><p>Gerçek kaynaklardan doğrulanan adaylar burada gösterilir. Aday, AL sinyali değildir.</p><div id="candidateList" class="cards"><div class="empty">Henüz aday yok.</div></div><h2>🎯 Sniper · Tek Slot</h2><div id="sniperPosition" class="panel">Açık Sniper işlemi yok.</div><h2>🪑 Dinamik Yedek Havuz</h2><p>Mini onaylı adaylar güç sırasıyla gösterilir. Bozulan veya bayatlayan aday giriş için kullanılmaz.</p><div id="sniperStandby" class="cards"></div><h2>⚡ SCALP Slotları</h2><div id="scalpSlots" class="cards"></div></div><div id="radar" class="page"><h2>🎯 Radar</h2><p>⚡ Günlük Al-Sat · 📈 Swing · 🐋 Sessiz Balina</p><div class="empty" id="radarState">Doğrulanmış piyasa mum verisi gelmeden otomatik hisse taraması yapılamıyor.</div><h2>Manuel hisse araştırması</h2><div class="panel"><p>Bu bölüm sinyal değildir, mevcut araştırma testidir.</p><input id="symbol" value="ASTOR" maxlength="6" autocapitalize="characters" placeholder="Hisse kodu"><button id="go">Araştır</button><pre id="result">Henüz araştırma yapılmadı.</pre></div></div>
<div id="signals" class="page"><h2>✅ Onaylı Sinyaller</h2><div class="empty" id="signalsPage">Teknik filtre ve resmî risk teyidinden geçmiş sinyal henüz bulunmuyor.</div><p>Bir haberin aramada çıkmaması, risk bulunmadığının kanıtı değildir.</p></div>
<div id="demo" class="page"><h2>💼 Demo Portföy</h2><div class="hero"><small>Başlangıç sanal kasa</small><div><strong id="demoTotal">5.000,00 TL</strong></div><p>SCALP ve SNIPER kasaları ayrı tutulur. Gerçek banka emri verilmez.</p></div><h2>Açık İşlemler</h2><div class="empty" id="demoOpen">Açık sanal işlem bulunmuyor.</div><h2>Gemini için Denetim Karnesi</h2><button id="copyReport">📋 Karneyi kopyala</button><pre id="reportResult">Seans verisi ve AI kararları burada kopyalanabilir.</pre><h2>Kapanan İşlemler</h2><div class="empty" id="demoClosed">Henüz kapanan işlem yok.</div></div>
<div id="settings" class="page"><h2>⚙️ Ayarlar ve Bağlantılar</h2><div class="panel"><p>Mevcut erişim tokenını girince Gemini, GPT ve radar durumu otomatik kontrol edilir. Token cihazda saklanmaz.</p><input id="token" type="password" autocomplete="off" placeholder="ACCESS_TOKEN"><button id="check">🔌 API bağlantılarını kontrol et</button><pre id="checkResult">Token bekleniyor.</pre><button id="pushOn">🔔 iPhone bildirimlerini etkinleştir</button><pre id="pushStatus">VAPID ve bildirim gönderimi henüz doğrulanmadı.</pre></div><h2>📋 Ortak Teknik Belge</h2><div class="panel"><p>GPT ve Gemini için güncel teknik belge.</p><button id="copyDoc">📋 Teknik belge bağlantısını kopyala</button><p id="copyStatus" class="muted">Gemini sohbetine yapıştırabilirsin.</p></div><h2>🌙 Gece taraması</h2><div class="panel"><p>Son kapanmış günlük mumlarla sistemin kendi testini çalıştır. Onaylı AL sinyali değil, teknik radar testidir.</p><button id="nightTest">🌙 Bulut besleme durumunu göster</button><pre id="nightResult">Henüz bu oturumdan başlatılmadı.</pre></div><h2>Diagnostik</h2><div class="panel"><p>Gemini üretim testleri AI kotası kullanabilir.</p><button id="plain">Basit Gemini testi</button><button id="ground">Gemini Google Search testi</button><pre id="testResult">Henüz test edilmedi.</pre></div></div>
</main><nav class="nav"><button data-page="candidates"><b>◉</b>Adaylar</button><button class="active" data-page="home"><b>⌂</b>Ana</button><button data-page="radar"><b>◎</b>Radar</button><button data-page="signals"><b>✓</b>Sinyaller</button><button data-page="demo"><b>▣</b>Demo</button><button data-page="settings"><b>⚙</b>Ayarlar</button></nav>
<script>
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
const token=document.getElementById('token');let pending=false,lastData=null;const headers=()=>token.value.trim()?({Authorization:'Bearer '+token.value.trim()}):({});const money=n=>Number(n||0).toLocaleString('tr-TR',{minimumFractionDigits:2,maximumFractionDigits:2})+' TL';
function navigate(p){document.querySelectorAll('[data-page]').forEach(x=>x.classList.toggle('active',x.dataset.page===p));document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id===p));window.scrollTo(0,0)}
document.querySelectorAll('[data-jump]').forEach(x=>{x.onclick=()=>navigate(x.dataset.jump);x.onkeydown=e=>{if(e.key==='Enter')x.click()}});
document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-page]').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id===b.dataset.page));window.scrollTo(0,0)});
document.querySelectorAll('[data-candidate-filter]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-candidate-filter]').forEach(x=>x.classList.toggle('active',x===b));if(lastData)renderOverview(lastData)});
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('active',x===b));});
function setDot(which,state,text){document.getElementById(which+'Dot').className='dot '+state;document.getElementById(which+'Text').textContent=text}
document.getElementById('copyReport').onclick=async()=>{const out=document.getElementById('reportResult');try{const r=await fetch('/bist/report',{headers:headers()});const report=await r.json();if(!r.ok)throw Error('Karne erişimi: '+r.status);const text='BIST teknik denetim karnesi\nhttps://github.com/baykatemizlik-dotcom/ai-evi/blob/main/CLOUD_BRIDGE.md\n'+JSON.stringify(report,null,2);out.textContent=text;await navigator.clipboard.writeText(text);out.textContent='Kopyalandı.\n'+text;}catch(e){out.textContent+='\n'+e.message;}};
async function checkApis(){if(pending)return;pending=true;setDot('gemini','wait','Kontrol');setDot('gpt','wait','Kontrol');try{
const [a,b,c]=await Promise.all([fetch('/bist/connections',{headers:headers()}),fetch('/bist/overview',{headers:headers()}),fetch('/bist/status',{headers:headers()})]);const x=await a.json(),o=await b.json(),status=await c.json();if(a.status===401){setDot('gemini','','Oturum gerekli');setDot('gpt','','Oturum gerekli');document.getElementById('checkResult').textContent='Bir defa erişim tokenı girerek oturum aç.';return}document.getElementById('checkResult').textContent=JSON.stringify(x,null,2);for(const [label,field] of [['gemini','gemini'],['gpt','openai']]){const ok=a.ok&&x[field]&&x[field].connection==='CONNECTED';setDot(label,ok?'ok':'bad',ok?'Bağlı':(field==='openai'?(x.openai?.connection==='CONFIGURED'?'Mini hazır · ilk karar bekleniyor':x.openai?.connection==='ERROR'?'Mini API hatası':'Mini anahtarı eksik'):'Bulut köprü modunda kapalı'))}if(b.ok){lastData=o;renderOverview(o)}document.getElementById('mainState').textContent=status.scanner_live?'Bulut radar aktif':'Veri bekleniyor';
}catch(e){setDot('gemini','bad','Hata');setDot('gpt','bad','Hata');document.getElementById('checkResult').textContent=String(e.message)}finally{pending=false}}
function renderOverview(d){
 const standby=document.getElementById('sniperStandby');standby.replaceChildren();
 for(const [rank,q] of (d.sniper_queue||[]).entries()){const el=document.createElement('div');el.className='tile';el.textContent=(rank+1)+'. '+q.symbol+' · Güven '+q.confidence+'/100 · '+(q.fresh?'Taze':'Bayat · giriş kapalı')+' · '+q.reason+' · Son mum '+new Date(q.last_checked_bar).toLocaleString('tr-TR',{timeZone:'Europe/Istanbul'});standby.append(el);}
 if(!standby.children.length){const el=document.createElement('div');el.className='empty';el.textContent='Mini onaylı taze yedek bekleniyor.';standby.append(el);}
 const sniper=(d.open_trades||[]).find(t=>t.strategy==='SWING');document.getElementById('sniperPosition').textContent=sniper?'SNIPER · '+sniper.symbol+' · '+sniper.lot_count+' lot · Stop '+money(d.sniper_state?.stop_price)+' · Tepe '+money(d.sniper_state?.peak_price):'Tek slot boş · Kasa '+money(d.swing_cash);
 const cap=Number(d.equity||d.total_capital||5000);document.getElementById('total').textContent=money(cap);document.getElementById('demoTotal').textContent=money(cap);document.getElementById('scalpCash').textContent=money(d.scalp_cash);document.getElementById('swingCash').textContent=money(d.swing_cash);document.getElementById('approved').textContent=String(d.approved||0);document.getElementById('candidates').textContent=String(d.candidates||0);document.getElementById('scanned').textContent=String(d.scanned||0);document.getElementById('lastRun').textContent=d.latest_run?'Son görev: '+d.latest_run.phase+' · '+d.latest_run.status:'Son tarama: bekleniyor';document.getElementById('marketState').textContent=d.scanner_live?'Bulut verisi aktif · gösterge niteliğinde':'Taze 15m veri bekleniyor';document.getElementById('xuState').textContent='Veri bekleniyor';document.getElementById('watchlist').textContent=d.candidates>0?'Havuzdaki '+d.candidates+' adayı görmek için dokun →':'Henüz teknik koşulları sağlayan aday yok.';
const list=document.getElementById('candidateList');list.replaceChildren();const candidateFilter=document.querySelector('[data-candidate-filter].active')?.dataset.candidateFilter||'ALL';
for(const a of (d.watchlist||[]).filter(x=>candidateFilter==='ALL'||x.strategy===candidateFilter)){const b=document.createElement('button');b.textContent=(a.strategy==='SCALP'?'⚡ SCALP':a.strategy==='SWING'?'🎯 SNIPER':a.strategy==='WHALE'?'🐋 BALİNA':'STRATEJİ BELİRSİZ')+' · '+a.symbol+' · '+(a.verified?'Doğrulandı':'Teyit bekliyor')+' · '+a.source;b.onclick=()=>alert('Hisse: '+a.symbol+'\nKaynak: '+a.source+'\nDurum: '+(a.verified?'Doğrulandı':'Teyit bekliyor')+'\nAL sinyali değildir.');list.append(b)}
if(!list.children.length){const e=document.createElement('div');e.className='empty';e.textContent='Doğrulanmış aday bulunmuyor.';list.append(e)}
const slots=document.getElementById('scalpSlots');slots.replaceChildren();for(const id of [1,2]){const t=(d.open_trades||[]).find(x=>x.strategy==='SCALP'&&x.slot_id===id);const el=document.createElement('div');el.className='tile';el.textContent=t?'Slot '+id+' · '+t.symbol+' · '+t.lot_count+' lot':'Slot '+id+' · Boş · 1.250 TL';slots.append(el)}const o=d.open_trades||[],c=d.closed_trades||[];const openText=o.length?o.map(x=>x.strategy+' · '+x.symbol+' · '+x.lot_count+' lot · '+money(x.executed_price)).join('\n'):'Henüz sanal işlem açılmadı.';document.getElementById('openHome').textContent=openText;document.getElementById('demoOpen').textContent=openText;document.getElementById('demoClosed').textContent=c.length?c.map(x=>x.symbol+' · Net K/Z '+money(x.pnl_net)).join('\n'):'Henüz kapanan işlem yok.';document.getElementById('performanceHome').textContent=c.length?'Kapanan işlem: '+c.length+' · Net toplam: '+money(c.reduce((sum,x)=>sum+Number(x.pnl_net||0),0)):'Henüz kapanan işlem yok.'}
async function loginAndCheck(){if(token.value.trim()){const r=await fetch('/bist/session',{method:'POST',headers:{Authorization:'Bearer '+token.value.trim()}});if(!r.ok){document.getElementById('checkResult').textContent='Erişim tokenı hatalı';return}token.value=''}await checkApis()}token.addEventListener('change',loginAndCheck);document.getElementById('check').onclick=loginAndCheck;checkApis();
document.getElementById('go').onclick=async()=>{const sym=document.getElementById('symbol').value.trim().toUpperCase(),out=document.getElementById('result');if(!/^[A-Z0-9]{3,6}$/.test(sym)){out.textContent='Geçersiz sembol';return}out.textContent='Araştırılıyor';try{const r=await fetch('/bist/research',{method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:JSON.stringify({symbol:sym})});out.textContent='HTTP '+r.status+'\n'+JSON.stringify(await r.json(),null,2)}catch(e){out.textContent=String(e)}};
document.getElementById('nightTest').onclick=async()=>{const b=document.getElementById('nightTest'),o=document.getElementById('nightResult');b.disabled=true;o.textContent='Bot kapanmış mumları tarıyor...';try{const r=await fetch('/bist/status',{headers:headers()});const j=await r.json();o.textContent='HTTP '+r.status+'\\n'+JSON.stringify(j,null,2);if(r.ok)await checkApis()}catch(e){o.textContent='Tarama hatası: '+e.message}finally{b.disabled=false}};
document.getElementById('copyDoc').onclick=async()=>{const link='https://docs.google.com/document/d/1G6Gj9O0dPHaNY0MdWhEp_F3EKyn_Q0sC9RaV9cxY2uk/edit';try{await navigator.clipboard.writeText(link);document.getElementById('copyStatus').textContent='Bağlantı kopyalandı ✅'}catch{document.getElementById('copyStatus').textContent='Kopyalanamadı. Belge bağlantısı: '+link}};
document.getElementById('pushOn').onclick=async()=>{const out=document.getElementById('pushStatus');try{if(!('serviceWorker'in navigator)||!('PushManager'in window))throw Error('iPhone için PWA ana ekrandan açılmalı.');const permission=await Notification.requestPermission();if(permission!=='granted')throw Error('Bildirim izni verilmedi');const reg=await navigator.serviceWorker.ready;const k=await fetch('/push/key',{headers:headers()});if(!k.ok)throw Error('VAPID anahtarı henüz kurulmadı');const j=await k.json();const base=j.key.replace(/-/g,'+').replace(/_/g,'/');const raw=atob(base.padEnd(Math.ceil(base.length/4)*4,'='));const bytes=Uint8Array.from(raw,x=>x.charCodeAt(0));const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});const r=await fetch('/push/subscribe',{method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:JSON.stringify(sub)});if(!r.ok)throw Error('Abonelik kaydedilemedi');out.textContent='Abonelik kaydedildi. Gerçek bildirim göndericisi henüz tamamlanmadı.'}catch(e){out.textContent=String(e.message)}};
for(const [id,mode] of [['plain','plain'],['ground','grounding']])document.getElementById(id).onclick=async()=>{const out=document.getElementById('testResult');out.textContent='Test yapılıyor';try{const r=await fetch('/bist/gemini-test?mode='+mode,{headers:headers()});out.textContent='HTTP '+r.status+'\n'+JSON.stringify(await r.json(),null,2)}catch(e){out.textContent=String(e)}};
</script></body></html>`;
 if((u.pathname==="/"||u.pathname==="/bist")&&request.method==="GET")return new Response(dashboard,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"}});
 if(u.pathname==="/manifest.json")return new Response(JSON.stringify({name:"BIST AVCI",short_name:"BIST AVCI",start_url:"/",scope:"/",display:"standalone",background_color:"#0c1220",theme_color:"#0c1220",icons:[{src:"/icon.svg",sizes:"any",type:"image/svg+xml",purpose:"any maskable"}]}),{headers:{"Content-Type":"application/manifest+json","Cache-Control":"max-age=300"}});
 if(u.pathname==="/icon.svg")return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192"><rect width="192" height="192" rx="36" fill="#0c1220"/><path d="M30 140 L65 105 L92 121 L135 59 L165 72" fill="none" stroke="#58d0a0" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/><text x="26" y="50" fill="white" font-size="27" font-family="sans-serif">BIST</text></svg>',{headers:{"Content-Type":"image/svg+xml","Cache-Control":"max-age=86400"}});
 if(u.pathname==="/sw.js")return new Response("self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('push',e=>{let x={title:'BIST AVCI',body:'Yeni doğrulanmış sinyal var. Paneli açıp kontrol et.'};try{if(e.data)x={...x,...e.data.json()}}catch{}e.waitUntil(self.registration.showNotification(x.title,{body:x.body,icon:'/icon.svg',tag:'bist-signal',data:{url:'/'}}))});self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(self.clients.openWindow('/'))})",{headers:{"Content-Type":"application/javascript","Service-Worker-Allowed":"/","Cache-Control":"no-cache"}});
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
 if(['/bist/feed/ingest','/bist/feed/risk','/bist/feed/monitor','/bist/feed/report','/bist/feed/finalize','/bist/feed/daily','/bist/feed/audit','/bist/feed/probe'].includes(u.pathname)){
  if(['/bist/feed/monitor','/bist/feed/daily'].includes(u.pathname)?request.method!=='GET':request.method!=='POST')return reply({error:'METHOD_NOT_ALLOWED'},405);
  const ingestToken=env.BIST_INGEST_TOKEN||env.ACCESS_TOKEN;
  if(!ingestToken)return reply({error:'INGEST_TOKEN_NOT_CONFIGURED'},503);
  if(!provided || !await secureEqual(provided,ingestToken))return reply({error:'Unauthorized'},401);
  try{if(u.pathname.endsWith('/probe'))return await probeMini(env);
   if(u.pathname.endsWith('/daily'))return reply(await dailyReport(env.DB));
   if(u.pathname.endsWith('/audit'))return await externalAudit(request,env);
   if(u.pathname.endsWith('/monitor'))return await monitorSymbols(env);
   if(u.pathname.endsWith('/risk'))return await riskIngest(request,env);
   if(u.pathname.endsWith('/report'))return await reportIngest(request,env);
   if(u.pathname.endsWith('/finalize'))return await finalize(request,env);
   return await ingest(request,env);}catch{return reply({error:'INGEST_OR_ENGINE_FAILED',retry_safe:true},503);}
 }
 if(!authenticated)return reply({error:"Unauthorized"},401);

 if(u.pathname==='/bist/status'||u.pathname==='/bist/bridge/status')return reply(await feedStatus(env.DB));
 if(u.pathname==='/bist/connections')return reply({mode:'CLOUD_BRIDGE_AI_REFEREE',external_fetch_enabled:true,market_data_fetch_enabled:false,gemini:{connection:'DISABLED'},openai:await aiStatus(env)});
 if(u.pathname==='/bist/ai/decisions')return reply({decisions:(await env.DB.prepare('SELECT symbol,bar_time,model,status,reason,completed_at,confidence,input_tokens,output_tokens FROM bist_ai_decisions ORDER BY created_at DESC LIMIT 100').all()).results});
 if(u.pathname==='/bist/report'){const report=await dailyReport(env.DB);const audit=await env.DB.prepare('SELECT * FROM bist_external_audits ORDER BY trt_date DESC LIMIT 1').first();return reply({...report,external_audit:audit?{...audit,report:JSON.parse(audit.report_json)}:null});}
 if(u.pathname==='/bist/overview'){
  const [status,accounts,open,closed,signals,standby,sniperStates]=await Promise.all([
   feedStatus(env.DB),env.DB.prepare('SELECT * FROM paper_cash_accounts').all(),
   env.DB.prepare("SELECT * FROM virtual_trades WHERE status='OPEN' ORDER BY entry_time DESC LIMIT 30").all(),
   env.DB.prepare("SELECT * FROM virtual_trades WHERE status='CLOSED' ORDER BY exit_time DESC LIMIT 30").all(),
   env.DB.prepare("SELECT symbol,source,'SCALP' strategy,0 verified,observed_at created_at FROM bist_feed_signals WHERE observed_at>=date('now') ORDER BY observed_at DESC LIMIT 30").all(),
   env.DB.prepare("SELECT * FROM bist_sniper_queue WHERE status='READY' ORDER BY score DESC,confidence DESC,symbol ASC").all(),
   env.DB.prepare("SELECT s.* FROM bist_sniper_state s JOIN virtual_trades t ON t.id=s.trade_id WHERE t.status='OPEN'").all()]);
  const account=Object.fromEntries((accounts.results||[]).map(x=>[x.strategy,x.available_cash]));
  const openTrades=open.results||[];
  return reply({...status,total_capital:5000,equity:(account.SCALP||0)+(account.SWING||0)+openTrades.reduce((s,t)=>s+t.executed_price*t.lot_count,0),
   sniper_queue:(standby.results||[]).map(q=>({...q,fresh:fresh({bar_time:q.last_checked_bar,feed_type:'INDICATIVE_INTRADAY'},Date.now())})),sniper_state:sniperStates.results?.[0]||null,
   scalp_cash:account.SCALP||0,swing_cash:account.SWING||0,open_trades:openTrades,closed_trades:closed.results||[],
   scanned:status.scanned_symbols||status.active_symbols,approved:signals.results.length,candidates:signals.results.length,watchlist:signals.results,
   latest_run:status.last_received?{phase:'CLOUD_BRIDGE',status:status.status,created_at:status.last_received}:null});
 }
 return reply({error:'DISABLED_IN_INGRESS_ONLY_MODE',external_fetch_enabled:false},410);
},async scheduled(controller,env){return await enforceSessionClose(env.DB,controller.scheduledTime||Date.now());}};
