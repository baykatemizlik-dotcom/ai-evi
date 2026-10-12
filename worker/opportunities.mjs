import {json,trtParts,trtDate,entryPlan,symbolBars} from './cloud_bridge.mjs';
import {usableQuote,scalpExit,strategyThresholds} from './strategy_engines.mjs';
const premiumReason='Teknik kriterler tam uyumlu, ancak sabah %6.50 tavan riski koruması nedeniyle otomatik işlem reddedildi. Radar izlemede.';
export function morningPremium(previous,price,now){
 const p=trtParts(now),morning=+p.hour*60+ +p.minute<780;
 if(!morning)return {blocked:false,daily_change_pct:previous>0?100*(price/previous-1):null};
 if(!Number.isFinite(previous)||previous<=0||!Number.isFinite(price)||price<=0)return {blocked:true,reason:'PREVIOUS_SESSION_CLOSE_MISSING',daily_change_pct:null};
 const pct=100*(price/previous-1);return {blocked:pct>=6.5-1e-9,reason:pct>=6.5-1e-9?'MORNING_PREMIUM_6_5':null,daily_change_pct:pct};
}
export async function saveMarketContext(db,symbol,context,now){
 if(!context)return false;const t=Date.parse(context.bar_time);
 if(context.source!=='YAHOO_INDICATIVE'||!Number.isFinite(context.close)||context.close<=0||!Number.isFinite(t)||trtDate(t)>=trtDate(now)||now-t>7*86400000)return false;
 await db.prepare('INSERT INTO strategy_market_context VALUES(?,?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET session_date=excluded.session_date,previous_close=excluded.previous_close,previous_bar_time=excluded.previous_bar_time,received_at=excluded.received_at').bind(symbol,trtDate(now),context.close,context.bar_time,new Date(now).toISOString()).run();return true;
}
export async function scalpPremiumGuard(db,symbol,price,now){
 if(+trtParts(now).hour>=13)return {blocked:false,daily_change_pct:null};
 const c=await db.prepare('SELECT * FROM strategy_market_context WHERE symbol=? AND session_date=?').bind(symbol,trtDate(now)).first();
 return morningPremium(c?.previous_close,price,now);
}
export async function captureOpportunity(db,strategy,symbol,key,stage,bar,metrics,now){
 const q=await db.prepare('SELECT * FROM strategy_quotes WHERE symbol=?').bind(symbol).first();
 await db.prepare('INSERT OR IGNORE INTO opportunity_events VALUES(?,?,?,?,?,?,?,?,?,?)').bind(stage+':'+strategy+':'+key,strategy,symbol,key,stage,new Date(now).toISOString(),bar,JSON.stringify(metrics),usableQuote(q,now)?JSON.stringify(q):null,'OBSERVED').run();
}
export async function capturePremium(db,symbol,key,bar,metrics,guard,now){
 if(guard.reason!=='MORNING_PREMIUM_6_5')return;
 await db.prepare('INSERT OR IGNORE INTO high_momentum_radar VALUES(?,?,?,?,?,?,?,?)').bind(key,symbol,guard.daily_change_pct,metrics.rvol||0,premiumReason,new Date(now).toISOString(),bar,'REJECTED').run();
 await captureOpportunity(db,'SCALP',symbol,key,'HIGH_PREMIUM',bar,{...metrics,daily_change_pct:guard.daily_change_pct,reason:premiumReason},now);
}
export async function highMomentumRadar(db,now=Date.now()){
 const r=await db.prepare("SELECT symbol,daily_change_pct,rvol,reason,captured_at,bar_time,decision FROM high_momentum_radar WHERE captured_at>=? AND captured_at<? ORDER BY captured_at DESC LIMIT 200").bind(new Date(trtDate(now)+'T00:00:00+03:00').toISOString(),new Date(Date.parse(trtDate(now)+'T00:00:00+03:00')+86400000).toISOString()).all();
 // Compare true UTC ISO strings, not strings with timezone suffixes.
 return (r.results||[]).filter(x=>trtDate(Date.parse(x.captured_at))===trtDate(now));
}
export function simulateOpportunity(event,bars,quotes,hour=[],daily=[],now=Date.now(),budget=6250){
 const q=event.entry_quote_json?JSON.parse(event.entry_quote_json):null,at=Date.parse(event.captured_at);
 if(!q||!usableQuote(q,at))return {status:'ENTRY_DATA_NOT_RECORDED',reason:'Bu aşamanın giriş fiyatı o anda kaydedilmemiş; geriye dönük fiyat uydurulmaz.'};
 const plan=entryPlan(budget,q.price,budget);if(plan.qty<(event.strategy==='SWING'?2:1))return {status:'INSUFFICIENT_LOT_BUDGET'};
 const metrics=JSON.parse(event.metrics_json),t={strategy:event.strategy,executed_price:plan.executed,lot_count:plan.qty,remaining_lots:plan.qty,commission:plan.commission,entry_time:event.captured_at,tp1_done:0,trailing_stop:metrics.initial_stop||null};
 if(t.strategy==='SWING'&&!t.trailing_stop)return {status:'ENTRY_DATA_NOT_RECORDED',reason:'İlk Trend stopu kaydedilmemiş.'};
 let realised=0,last=q,exit=null;const legs=[];
 const sell=(qty,raw,reason,time)=>{const pnl=raw*.998*.998*qty-(t.executed_price+t.commission/t.lot_count)*qty;realised+=pnl;t.remaining_lots-=qty;legs.push({qty,price:raw*.998,reason,at:time,pnl_net:pnl});if(!t.remaining_lots)exit={reason,at:time};};
 // Every observation is ordered by availability, never by a hindsight price.
 const observations=[...quotes.filter(x=>Date.parse(x.received_at)>at&&Date.parse(x.received_at)<=now).map(x=>({at:Date.parse(x.received_at),q:x})),...(t.strategy==='SCALP'?bars:hour).filter(b=>Date.parse(b.bar_time)>=at&&Date.parse(b.bar_time)+(t.strategy==='SCALP'?900000:3600000)<=now).map(b=>({at:Math.max(Date.parse(b.first_received_at||b.received_at),Date.parse(b.bar_time)+(t.strategy==='SCALP'?900000:3600000)),b}))].filter(x=>x.at<=now).sort((a,b)=>a.at-b.at||(a.b?-1:1));
 const seen=[];const thresholds=strategyThresholds(t);
 for(const item of observations){if(exit)break;if(item.q)last=item.q;else seen.push(item.b);
  if(t.strategy==='SCALP'){
   for(let step=0;step<2;step++){const result=scalpExit(t,seen,item.q||null,item.at);if(!result)break;const qty=result.qty??t.remaining_lots;sell(qty,result.raw,result.reason,new Date(item.at).toISOString());if(!exit&&result.reason==='SCALP_TP1'){t.tp1_done=1;t.scalp_runner_started_at=result.activation||result.time;}else break;}
  }else{
   const b=item.b,price=item.q?.price,qt=item.q?Date.parse(item.q.quote_time):null;
   if(item.q&&(!usableQuote(item.q,item.at)||qt<Math.max(at,t.last_processed_trend_bar?Date.parse(t.last_processed_trend_bar)+3600000:0)))continue;
   const low=b?b.low:price,high=b?b.high:price,open=b?b.open:price;
   if(low<=t.trailing_stop){sell(t.remaining_lots,Math.min(open,t.trailing_stop),t.tp1_done?'TREND_TRAILING':'TREND_INITIAL_STOP',new Date(item.at).toISOString());continue;}
   if(!t.tp1_done&&high>=thresholds.tp){sell(Math.floor(t.lot_count/2),b?thresholds.tp:price,'TREND_TP1',new Date(item.at).toISOString());t.tp1_done=1;t.trailing_stop=Math.max(t.trailing_stop,thresholds.breakeven);}
   if(b){const prior=hour.filter(x=>x.bar_time<=b.bar_time).slice(-2);t.trailing_stop=Math.max(t.trailing_stop,t.tp1_done&&prior.length===2?Math.min(...prior.map(x=>x.low)):0);t.last_processed_trend_bar=b.bar_time;}
   if(item.q&&daily.filter(x=>trtDate(Date.parse(x.bar_time))>=trtDate(at)&&Date.parse(x.bar_time)<item.at).length>=5)sell(t.remaining_lots,price,'TREND_MAX_5_SESSIONS',new Date(item.at).toISOString());
  }
 }
 const unrealised=t.remaining_lots?last.price*.998*.998*t.remaining_lots-(t.executed_price+t.commission/t.lot_count)*t.remaining_lots:0;
 return {status:exit?'CLOSED':'OPEN',entry_time:event.captured_at,entry_quote_time:q.quote_time,executed_price:t.executed_price,lot_count:t.lot_count,remaining_lots:t.remaining_lots,thresholds,initial_stop:metrics.initial_stop||thresholds.sl,budget,realised_pnl:realised,unrealised_pnl:unrealised,pnl_net:realised+unrealised,pnl_pct:100*(realised+unrealised)/budget,last_price:last.price,last_quote_time:last.quote_time,quote_stale:!usableQuote(last,now),exit,legs};
}
export function reconstructOpportunity(event,reconstruction,now=Date.now(),budget=6250){
 const entry=reconstruction?.entries?.[event.event_key],at=Date.parse(event.captured_at),time=Date.parse(entry?.bar_time);
 if(!entry||entry.source!=='YAHOO_HISTORICAL_NEXT_MINUTE_OPEN'||entry.interval!=='1m'||!(entry.price>0)||!Number.isFinite(time)||time<at||time>at+120000||time+60000>now)return {status:'ENTRY_DATA_NOT_RECORDED',reason:'Bulunma anından sonraki iki dakika içinde doğrulanmış Yahoo 1m açılışı bulunamadı.'};
 const cached=reconstruction.scenarios?.[event.event_key];if(cached?.retrospective&&cached.entry_time===entry.bar_time&&Date.parse(cached.scenario_as_of)<=now)return {...cached,quote_stale:cached.status==='OPEN'?true:cached.quote_stale};
 const history=reconstruction.history?.[event.symbol]||{},observed=(interval,seconds)=>(history[interval]||[]).map(b=>({...b,received_at:new Date(Date.parse(b.bar_time)+seconds*1000).toISOString(),first_received_at:new Date(Date.parse(b.bar_time)+seconds*1000).toISOString()}));
 // These availability times belong only to a labelled retrospective scenario.
 // Original event, source candle and stored entry quote are never overwritten.
 const q={price:entry.price,quote_time:entry.bar_time,received_at:entry.bar_time,source:'YAHOO_INDICATIVE'};
 const quotes=(history['1m']||[]).filter(b=>Date.parse(b.bar_time)>=time).map(b=>({price:b.close,quote_time:new Date(Date.parse(b.bar_time)+60000).toISOString(),received_at:new Date(Date.parse(b.bar_time)+60000).toISOString(),source:'YAHOO_INDICATIVE'}));
 const scenario=simulateOpportunity({...event,captured_at:entry.bar_time,entry_quote_json:JSON.stringify(q)},observed('15m',900),quotes,observed('60m',3600),[],now,budget);
 return {...scenario,retrospective:true,entry_basis:entry.source,reconstructed_at:entry.retrieved_at,scenario_as_of:new Date(now).toISOString(),original_found_at:event.captured_at,reconstruction_note:'Geçmiş Yahoo 1m mumundan varsayımsal giriş: bulunma anından sonraki ilk açılış + %0,2 kayma + %0,2 komisyon. O anki veri gecikmesi/spread bilinmiyor; gerçek sanal alım değildir. Çıkışlar mevcut motor kurallarıyla geçmiş veriden değerlendirilir.'};
}
export async function opportunitiesOverview(db,date=trtDate(Date.now()),now=Date.now(),reconstruction=null){
 if(!/^\d{4}-\d\d-\d\d$/.test(date))throw Error('INVALID_DATE');
 const start=new Date(date+'T00:00:00+03:00').toISOString(),end=new Date(Date.parse(start)+86400000).toISOString();
 const rows=await db.prepare('SELECT * FROM opportunity_events WHERE captured_at>=? AND captured_at<? ORDER BY captured_at DESC LIMIT 500').bind(start,end).all();
 const cash=await db.prepare('SELECT strategy,initial_cash FROM paper_cash_accounts').all(),budgets=Object.fromEntries((cash.results||[]).map(x=>[x.strategy,x.initial_cash/2]));
 const groups=new Map();for(const e of rows.results||[]){const key=e.strategy+':'+e.signal_key;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e);}
 const cache=new Map(),result=[];
 for(const events of groups.values()){
  const first=[...events].sort((a,b)=>a.captured_at.localeCompare(b.captured_at))[0],symbol=first.symbol;
  if(!cache.has(symbol)){
   const [b,q,h,trades]=await Promise.all([db.prepare("SELECT b.*,o.first_received_at FROM bist_bridge_bars b LEFT JOIN opportunity_bar_observations o ON o.symbol=b.symbol AND o.interval=b.interval AND o.bar_time=b.bar_time WHERE b.symbol=? AND b.source='YAHOO_INDICATIVE' AND b.bar_time>=? ORDER BY b.bar_time LIMIT 700").bind(symbol,start).all(),db.prepare('SELECT * FROM opportunity_quotes WHERE symbol=? AND received_at>=? ORDER BY received_at LIMIT 2000').bind(symbol,start).all(),db.prepare('SELECT b.*,o.first_received_at FROM trend_bars b LEFT JOIN opportunity_bar_observations o ON o.symbol=b.symbol AND o.interval=b.interval AND o.bar_time=b.bar_time WHERE b.symbol=? AND b.bar_time>=? ORDER BY b.bar_time LIMIT 400').bind(symbol,start).all(),db.prepare('SELECT * FROM virtual_trades WHERE symbol=? AND entry_time>=? ORDER BY entry_time DESC').bind(symbol,start).all()]);cache.set(symbol,{bars:b.results||[],quotes:q.results||[],hour:(h.results||[]).filter(x=>x.interval==='60m'),daily:(h.results||[]).filter(x=>x.interval==='1d'),trades:trades.results||[]});
  }
  const data=cache.get(symbol),metrics=JSON.parse(first.metrics_json),key=first.signal_key;
  const queue=await db.prepare('SELECT status,reason,expires_at FROM '+(first.strategy==='SCALP'?'scalp_sniper_queue':'trend_radar_queue')+' WHERE signal_key=?').bind(key).first();
  const [ai,gemini]=first.strategy==='SCALP'?await Promise.all([db.prepare('SELECT status,reason,completed_at FROM bist_ai_decisions WHERE signal_key=?').bind(key).first(),db.prepare('SELECT status,reason,completed_at FROM bist_gemini_decisions WHERE signal_key=?').bind(key).first()]):[null,null];
  result.push({symbol,strategy:first.strategy,signal_key:key,bar_time:first.bar_time,found_at:first.captured_at,signal_price:metrics.last_candle?.close||(first.strategy==='SWING'?data.hour:data.bars).find(b=>b.bar_time===first.bar_time)?.close||null,metrics,stages:events.map(e=>{const s=simulateOpportunity(e,data.bars,data.quotes,data.hour,data.daily,now,budgets[e.strategy]||6250);return {stage:e.stage,captured_at:e.captured_at,origin:e.origin,scenario:s.status==='ENTRY_DATA_NOT_RECORDED'&&reconstruction?reconstructOpportunity(e,reconstruction,now,budgets[e.strategy]||6250):s};}),queue:queue?{...queue,status:queue.status==='READY'&&Date.parse(queue.expires_at)<=now?'EXPIRED':queue.status}:null,mini:ai,gemini,actual_trade:data.trades.find(t=>t.strategy===first.strategy&&t.feed_entry_key===(first.strategy==='SCALP'?'SCALP:':'TREND:')+key)||null});
 }
 const radar=await db.prepare('SELECT * FROM high_momentum_radar WHERE captured_at>=? AND captured_at<? ORDER BY captured_at DESC').bind(start,end).all();
 return {trt_date:date,server_time:new Date(now).toISOString(),paper_only:true,scenario_basis:'OBSERVED_YAHOO_QUOTE_AND_EXISTING_EXIT_RULES',opportunities:result,high_momentum_radar:radar.results||[],recording_started_at:(await db.prepare('SELECT MIN(received_at) started FROM opportunity_quotes').first())?.started||null,truncated:(rows.results||[]).length===500};
}
