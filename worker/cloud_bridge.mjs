// Ingress-only runtime: no network client, AI request, provider fetch or broker call.
export const SYMBOLS = new Set(['THYAO','TUPRS','ASELS','EREGL','AKBNK','GARAN','ISCTR','YKBNK','BIMAS','KCHOL','SAHOL','SISE','TCELL','TTKOM','FROTO','TOASO','ENKAI','PETKM','PGSUS','SASA']);
const FRESH_MS = 20 * 60000;
export const json = (body, status=200) => new Response(JSON.stringify(body), {
 status, headers: {'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}
});
export function sessionOpen(now) {
 const d = new Date(now+3*3600000), minutes = d.getUTCHours()*60+d.getUTCMinutes();
 return d.getUTCDay()>0 && d.getUTCDay()<6 && minutes>=600 && minutes<=1095;
}
export function fresh(row, now) {
 const end = Date.parse(row.bar_time || row.time)+900000;
 return row.feed_type==='INDICATIVE_INTRADAY' && end<=now && now-end<=FRESH_MS && sessionOpen(now);
}
export function validate(data, now=Date.now()) {
 if (!data || !['YAHOO_INDICATIVE','TWELVE_DATA_XIST_EOD'].includes(data.source) ||
     data.feed_type!==(data.source==='YAHOO_INDICATIVE'?'INDICATIVE_INTRADAY':'EOD') ||
     !Array.isArray(data.bars) || !data.bars.length || data.bars.length>200)
  throw Error('INVALID_ENVELOPE');
 const symbols = new Set(), keys = new Set();
 const bars = data.bars.map(b=>{
  if (!b || !SYMBOLS.has(b.symbol) || b.interval!=='15m' || typeof b.time!=='string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(b.time)) throw Error('INVALID_BAR');
  const ts=Date.parse(b.time), values=[b.open,b.high,b.low,b.close,b.volume];
  if (!Number.isFinite(ts) || ts+900000>now || ts<now-7*86400000 ||
      !values.every(v=>typeof v==='number'&&Number.isFinite(v)) ||
      Math.min(b.open,b.high,b.low,b.close)<=0 || b.volume<0 ||
      b.low>Math.min(b.open,b.close) || b.high<Math.max(b.open,b.close)) throw Error('INVALID_BAR');
  const time=new Date(ts).toISOString(), key=b.symbol+time;
  if(keys.has(key))throw Error('DUPLICATE_BAR'); keys.add(key); symbols.add(b.symbol);
  return {symbol:b.symbol,interval:'15m',time,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume};
 });
 // One symbol/request bounds D1 queries and makes partial provider outages independent.
 if(symbols.size!==1)throw Error('ONE_SYMBOL_PER_REQUEST');
 return {source:data.source,feed_type:data.feed_type,bars:bars.sort((a,b)=>a.time.localeCompare(b.time))};
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
export function technicalSignal(bars) {
 if(bars.length<21)return null;
 const b=bars.at(-1), prev=bars.slice(-21,-1);
 const avg=prev.reduce((s,x)=>s+x.volume,0)/prev.length;
 const sessionBars=bars.filter(x=>(x.bar_time||x.time).slice(0,10)===(b.bar_time||b.time).slice(0,10));
 const total=sessionBars.reduce((s,x)=>s+x.volume,0);
 const vwap=total?sessionBars.reduce((s,x)=>s+(x.high+x.low+x.close)/3*x.volume,0)/total:0;
 const rvol=avg?b.volume/avg:0, body=(b.close-b.open)/(b.high-b.low||1);
 return rvol>=2.5 && body>=.6 && b.close>vwap && b.close>Math.max(...prev.map(x=>x.high))
  ? {rvol,vwap,body,classification:'TECHNICAL_PAPER_ONLY',risk_verified:false} : null;
}
export async function runPaper(db, symbol, now) {
 const rows=await db.prepare("SELECT * FROM bist_bridge_bars WHERE symbol=? AND interval='15m' AND source='YAHOO_INDICATIVE' ORDER BY bar_time DESC LIMIT 100").bind(symbol).all();
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
 if(pending){
  const next=bars.find(b=>b.bar_time>=pending.observed_at && b.bar_time<=pending.expires_at);
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
 const metrics=technicalSignal(bars);
 if(metrics){const key=symbol+':'+last.bar_time;
  const r=await db.prepare("INSERT OR IGNORE INTO bist_feed_signals(signal_key,symbol,bar_time,observed_at,expires_at,source,metrics_json) VALUES(?,?,?,?,?,'YAHOO_INDICATIVE',?)")
   .bind(key,symbol,last.bar_time,new Date(now).toISOString(),new Date(now+45*60000).toISOString(),JSON.stringify(metrics)).run();
  result.signals_created=r.meta.changes;
 }
 return result;
}
export async function ingest(request, env, now=Date.now()) {
 if(!env.DB)return json({error:'DB_MISSING'},503);
 if(!request.headers.get('Content-Type')?.startsWith('application/json'))return json({error:'JSON_REQUIRED'},415);
 // Limit actual stream bytes, including requests without Content-Length.
 const reader=request.body?.getReader(); if(!reader)return json({error:'EMPTY_BODY'},400);
 let size=0,chunks=[];
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
  if(size>100000){await reader.cancel();return json({error:'PAYLOAD_TOO_LARGE'},413);}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 let data;try{data=validate(JSON.parse(new TextDecoder().decode(bytes)),now);}catch(e){return json({error:e.message||'INVALID_JSON'},422);}
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
    (excluded.last_bar_time=bist_feed_state.last_bar_time AND excluded.feed_type='INDICATIVE_INTRADAY')`)
   .bind(symbol,latest.time,data.source,data.feed_type,received)
 ]);
 const active=fresh({...latest,feed_type:data.feed_type},now);
 // Run on retries too: a storage success + engine failure can recover safely.
 const engine=active?await runPaper(env.DB,symbol,now):{blocked:'STALE_OR_EOD',opened:0,closed:0,signals_created:0};
 return json({ok:true,status:active?'ACTIVE':'BLOCKED_MARKET_DATA_UNAVAILABLE',
  source:data.source,market_feed_verified:false,bar_rows:data.bars.length,new_bars:inserted[0].meta.changes,
  engine,orders_sent:0});
}
export async function feedStatus(db, now=Date.now()) {
 const rows=await db.prepare('SELECT * FROM bist_feed_state').all();
 const active=(rows.results||[]).filter(x=>fresh({bar_time:x.last_bar_time,feed_type:x.feed_type},now));
 return {status:active.length?'ACTIVE':'BLOCKED_MARKET_DATA_UNAVAILABLE',scanner_live:active.length>0,
  active_symbols:active.length,source:'GITHUB_ACTIONS_CLOUD_BRIDGE',market_feed_verified:false,
  paper_only:true,risk_verified:false,last_received:(rows.results||[]).map(x=>x.received_at).sort().at(-1)||null};
}
