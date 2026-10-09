// BIST AVCI research-only Cloudflare Worker. No AI Evi routes.
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
// Paper-trading sizing only; does not place trades.
const paperLotPlan=(budget,marketPrice,{slippage=0.002,commission=0.002}={})=>{
 const price=Number(marketPrice),cash=Number(budget);
 if(!Number.isFinite(price)||price<=0||!Number.isFinite(cash)||cash<=0)return {lots:0,firstTakeProfitLots:0,remainingLots:0,reason:"INVALID_PRICE_OR_BUDGET"};
 const executedPrice=price*(1+slippage);
 const lots=Math.floor(cash/(executedPrice*(1+commission)));
 const firstTakeProfitLots=lots>=2?Math.floor(lots/2):0;
 return {lots,executedPrice,estimatedEntryCost:lots*executedPrice*(1+commission),firstTakeProfitLots,remainingLots:lots-firstTakeProfitLots,partialExitPossible:firstTakeProfitLots>0,priceCap:null};
};
// Internal paper-only SCALP exit rule. Call only after verified, fresh market pricing.
const scalpExitDecision=(entryPrice,verifiedMarketPrice)=>{
 const entry=Number(entryPrice),price=Number(verifiedMarketPrice);
 if(!Number.isFinite(entry)||entry<=0||!Number.isFinite(price)||price<=0)return null;
 if(price>=entry*1.03)return "TP_FULL_3PCT";
 if(price<=entry*0.985)return "STOP_FULL_1P5PCT";
 return null;
};
const settleScalpPaperExit=async(db,trade,marketPrice,marketTimestamp)=>{
 if(!db||trade?.strategy!=="SCALP"||trade.status!=="OPEN"||!marketTimestamp||!Number.isFinite(Date.parse(marketTimestamp)))throw Error("Verified SCALP trade and timestamp required");
 const reason=scalpExitDecision(trade.executed_price,marketPrice);
 if(!reason)return {closed:false};
 const sell=Number(marketPrice)*0.998,qty=Number(trade.lot_count),commission=sell*qty*0.002;
 if(!Number.isInteger(qty)||qty<=0)throw Error("Invalid lots");
 const entryFee=Number(trade.commission||0);
 const pnl=(sell-Number(trade.executed_price))*qty-entryFee-commission;
 // D1 batch is transactional: either the trade closes and cash is credited together or neither.
 const results=await db.batch([
  db.prepare("UPDATE virtual_trades SET status='CLOSED',exit_price=?,exit_time=?,exit_reason=?,pnl_net=? WHERE id=? AND strategy='SCALP' AND status='OPEN'").bind(sell,marketTimestamp,reason,pnl,trade.id),
  db.prepare("UPDATE paper_cash_accounts SET available_cash=available_cash+?,updated_at=? WHERE strategy='SCALP' AND EXISTS(SELECT 1 FROM virtual_trades WHERE id=? AND status='CLOSED' AND exit_time=?)").bind(sell*qty-commission,marketTimestamp,trade.id,marketTimestamp)
 ]);
 return {closed:true,reason,pnl,results:results.map(x=>x.meta?.changes||0)};
};


// Deterministic paper-only execution. Real broker orders are never sent.
// Requires independently verified price and official disclosure gates.
const paperExecution=async(env,signal)=>{
 const {symbol,price,barTime,verified,kapVerified}=signal||{};
 if(!verified||!kapVerified||!/^[A-Z][A-Z0-9]{2,6}$/.test(symbol||"")||!(price>0)||!Number.isFinite(Date.parse(barTime)))return {ok:false,reason:"UNVERIFIED_INPUT"};
 if(Date.now()-Date.parse(barTime)>22*60000||Date.parse(barTime)>Date.now())return {ok:false,reason:"STALE_BAR"};
 const active=await env.DB.prepare("SELECT COUNT(*) n FROM virtual_trades WHERE strategy='SCALP' AND status='OPEN' AND symbol=?").bind(symbol).first();
 if(active.n)return {ok:false,reason:"ALREADY_OPEN"};
 const slots=await env.DB.prepare("SELECT slot_id FROM virtual_trades WHERE strategy='SCALP' AND status='OPEN'").all();
 const used=new Set(slots.results.map(x=>x.slot_id)),slot=[1,2].find(x=>!used.has(x));
 if(!slot)return {ok:false,reason:"SLOTS_FULL"};
 const cash=await env.DB.prepare("SELECT available_cash FROM paper_cash_accounts WHERE strategy='SCALP'").first();
 const budget=Math.min(1250,Number(cash?.available_cash||0));
 const plan=paperLotPlan(budget,price);
 if(!plan.lots)return {ok:false,reason:"INSUFFICIENT_CASH"};
 const entryFee=plan.lots*plan.executedPrice*0.002;
 const cost=plan.lots*plan.executedPrice+entryFee;
 if(cost>budget+1e-6)return {ok:false,reason:"OVER_BUDGET"};
 const ts=new Date().toISOString();
 // Conditional debit and trade insert in one D1 transaction. Abort if cash unavailable.
 const batch=await env.DB.batch([
  env.DB.prepare("UPDATE paper_cash_accounts SET available_cash=available_cash-?,updated_at=? WHERE strategy='SCALP' AND available_cash>=?").bind(cost,ts,cost),
  env.DB.prepare("INSERT INTO virtual_trades(strategy,symbol,signal_price,executed_price,lot_count,commission,entry_time,status,slot_id) SELECT 'SCALP',?,?,?,?,?,?,'OPEN',? WHERE EXISTS(SELECT 1 FROM paper_cash_accounts WHERE strategy='SCALP' AND updated_at=? AND available_cash>=0) AND NOT EXISTS(SELECT 1 FROM virtual_trades WHERE strategy='SCALP' AND status='OPEN' AND (symbol=? OR slot_id=?))").bind(symbol,price,plan.executedPrice,plan.lots,entryFee,ts,slot,ts,symbol,slot)
 ]);
 if(batch[0]?.meta?.changes!==1||batch[1]?.meta?.changes!==1)throw Error("PAPER_TRANSACTION_RECONCILIATION_FAILED");
 return {ok:true,symbol,slot,quantity:plan.lots,spent:cost};
};
const yahooOHLCV=async(symbol,interval="15m")=>{
 if(!/^[A-Z0-9]{3,7}$/.test(symbol))throw Error("invalid_symbol");
 const period=interval==="1d"?"6mo":"1mo";
 const url="https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(symbol+".IS")+"?range="+period+"&interval="+interval;
 const r=await fetch(url,{headers:{"Accept":"application/json"},signal:AbortSignal.timeout(8500)});
 if(!r.ok)throw Error("YAHOO_HTTP_"+r.status);
 const json=await r.json(),d=json.chart?.result?.[0],q=d?.indicators?.quote?.[0],times=d?.timestamp||[];
 if(!q||times.length<30)throw Error("INSUFFICIENT_OHLCV");
 const now=Math.floor(Date.now()/1000);
 const seconds=interval==="1d"?86400:900;
 const bars=times.map((t,i)=>({t,o:q.open?.[i],h:q.high?.[i],l:q.low?.[i],c:q.close?.[i],v:q.volume?.[i]})).filter(b=>[b.o,b.h,b.l,b.c,b.v].every(x=>typeof x==="number"&&Number.isFinite(x))&&b.h>=b.l&&b.v>=0&&(interval==="1d"?(new Date(b.t*1000).toLocaleDateString("sv-SE",{timeZone:"Europe/Istanbul"})<new Date().toLocaleDateString("sv-SE",{timeZone:"Europe/Istanbul"})||Number(new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Istanbul",hour:"2-digit",hourCycle:"h23"}).format(new Date()))>=19):b.t+seconds<=now-120));
 if(bars.length<30||now-bars[bars.length-1].t>86400*4)throw Error("STALE_OR_INSUFFICIENT_BARS");
 return bars;
};
const technicalCandidate=(bars)=>{
 const b=bars.at(-1),hist=bars.slice(-21,-1),recent=bars.slice(-6,-1);
 if(!b||hist.length<20||recent.length<5)return null;
 const avg=hist.reduce((a,x)=>a+x.v,0)/hist.length;
 const rvol=avg>0?b.v/avg:0,body=b.c-b.o,range=b.h-b.l;
 const priorHigh=Math.max(...recent.map(x=>x.h));
 const baseSize=recent.reduce((a,x)=>a+(x.h-x.l),0)/5;
 const vwapBars=bars.filter(x=>new Date(x.t*1000).toISOString().slice(0,10)===new Date(b.t*1000).toISOString().slice(0,10));
 const volume=vwapBars.reduce((a,x)=>a+x.v,0);
 const vwap=volume>0?vwapBars.reduce((a,x)=>a+((x.h+x.l+x.c)/3)*x.v,0)/volume:0;
 const passed=rvol>=2.5&&b.c>vwap&&body>0&&range>0&&body/range>=0.6&&(b.h-b.c)<=body&&b.c>priorHigh&&range>=1.5*baseSize;
 return {passed,price:b.c,rvol:Number(rvol.toFixed(2)),vwap:Number(vwap.toFixed(3)),volumeTL:Number((b.c*b.v).toFixed(2)),bar_timestamp:new Date(b.t*1000).toISOString()};
};
// KAP adapter intentionally fails closed until an official feed URL and supported schema are configured.
const kapPreflight=async(env)=>{
 if(!env.KAP_FEED_URL||!/^https:\/\/(?:www\.)?kap\.org\.tr\//i.test(env.KAP_FEED_URL))return {ready:false,reason:"OFFICIAL_KAP_URL_NOT_CONFIGURED"};
 try{const r=await fetch(env.KAP_FEED_URL,{signal:AbortSignal.timeout(7000),headers:{Accept:"application/json, application/rss+xml, application/xml"}});if(!r.ok)return {ready:false,reason:"KAP_HTTP_"+r.status};const txt=await r.text();if(!txt||txt.length<40)return {ready:false,reason:"KAP_EMPTY"};return {ready:true,raw_length:txt.length,source:"kap.org.tr",verified_disclosures:false}}catch{return {ready:false,reason:"KAP_UNREACHABLE"}}
};
const scanUniverse=async(env)=>{
 let raw=[],source="NONE";
 if(env.BIST_UNIVERSE_URL){
   const u=new URL(env.BIST_UNIVERSE_URL);
   if(u.protocol!=="https:")throw Error("UNIVERSE_HTTPS_REQUIRED");
   const r=await fetch(u.toString(),{signal:AbortSignal.timeout(10000)});
   if(!r.ok)throw Error("UNIVERSE_HTTP_"+r.status);
   const j=await r.json();raw=Array.isArray(j)?j:Array.isArray(j.symbols)?j.symbols:[];source=u.hostname;
 }else if(env.SCAN_SYMBOLS){
   raw=String(env.SCAN_SYMBOLS).split(",");source="MANUAL_CONFIG";
 }else{
   // Public KAP page is a catalogue. Never infer tradability from a company count.
   const r=await fetch("https://www.kap.org.tr/tr/Pazarlar",{headers:{"Accept":"text/html"},signal:AbortSignal.timeout(10000)});
   if(!r.ok)throw Error("KAP_UNIVERSE_HTTP_"+r.status);
   const html=await r.text();
   if(html.length<1000||html.length>4000000)throw Error("KAP_UNIVERSE_INVALID_HTML");
   // Section boundaries must follow the numbered market rows, not the page navigation.
   const strip=t=>t.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ").replace(/<[^>]*>/g," ").replace(/&nbsp;|&#160;/gi," ").replace(/\s+/g," ").trim();
   const page=strip(html);
   const star=page.search(/YILDIZ PAZAR\s+\d+\s+Şirket\s*\/\s*Fon Bulundu/i);
   const main=page.search(/ANA PAZAR\s+\d+\s+Şirket\s*\/\s*Fon Bulundu/i);
   const lower=page.search(/ALT PAZAR\s+\d+\s+Şirket\s*\/\s*Fon Bulundu/i);
   if(star<0||main<=star||lower<=main)throw Error("KAP_UNIVERSE_MARKET_SECTIONS_MISSING");
   const selected=page.slice(star,lower);
   raw=[...selected.matchAll(/(?:^|\s)\d{1,4}\s+\|?\s*([A-Z][A-Z0-9]{2,6})\s+\|?\s+/g)].map(x=>x[1]);
   source="KAP_PUBLIC_MARKET_CATALOG";
   if(raw.length<100||raw.length>1000)throw Error("KAP_UNIVERSE_PARSING_UNVERIFIED_"+raw.length);
 }
 const names=[...new Set(raw.map(x=>String(typeof x==="string"?x:x?.symbol||"").trim().toUpperCase()).filter(x=>/^[A-Z][A-Z0-9]{2,6}$/.test(x)))].slice(0,1000);
 if(!names.length)throw Error("UNIVERSE_EMPTY");
 return names;
};
const loadBridgeUniverse=async(env)=>{const r=await env.DB.prepare("SELECT symbol FROM bist_universe WHERE active=1 AND market IN ('YILDIZ','ANA') AND liquidity_tl>30000000 ORDER BY liquidity_tl DESC LIMIT 1000").all();return r.results.map(x=>x.symbol)};
const bridgeBars=async(env,symbol,interval)=>{const r=await env.DB.prepare("SELECT bar_time,open,high,low,close,volume,received_at FROM bist_bridge_bars WHERE symbol=? AND interval=? ORDER BY bar_time DESC LIMIT 90").bind(symbol,interval).all();const rows=r.results.reverse();if(rows.length<30)throw Error("BRIDGE_INSUFFICIENT_BARS");const last=rows.at(-1);if(Date.now()-Date.parse(last.bar_time)>4*86400000||Date.now()-Date.parse(last.received_at)>4*86400000)throw Error("BRIDGE_STALE");return rows.map(x=>({t:Math.floor(Date.parse(x.bar_time)/1000),o:x.open,h:x.high,l:x.low,c:x.close,v:x.volume}))};
// Optional licensed Twelve Data provider: ingest a bounded number per run, never invent OHLCV.
const ingestTwelve=async(env,interval="1day",limit=4)=>{
 if(!env.TWELVE_DATA_API_KEY)return {status:"NOT_CONFIGURED",fetched:0,errors:[]};
 const q=await env.DB.prepare("SELECT symbol FROM bist_universe WHERE active=1 AND market IN ('YILDIZ','ANA') AND liquidity_tl>30000000 ORDER BY symbol LIMIT 1000").all();
 const names=(q.results||[]).map(x=>x.symbol);
 if(!names.length)return {status:"NO_VERIFIED_UNIVERSE",fetched:0,errors:[]};
 // Rotate through the verified universe over time without exceeding bounded daily provider limits.
 const day=new Date().toISOString().slice(0,10),cursor=await env.DB.prepare("SELECT value FROM bist_settings WHERE key=?").bind("TWELVE_CURSOR_"+interval).first();
 const start=Math.max(0,Number(cursor?.value||0))%names.length;
 const symbols=Array.from({length:Math.min(limit,names.length)},(_,i)=>names[(start+i)%names.length]);
 let fetched=0;const errors=[];
 for(const symbol of symbols){
   try{
     const url=new URL("https://api.twelvedata.com/time_series");
     url.searchParams.set("symbol",symbol);url.searchParams.set("exchange","BIST");url.searchParams.set("interval",interval);url.searchParams.set("outputsize","65");url.searchParams.set("timezone","Europe/Istanbul");url.searchParams.set("format","JSON");
     const resp=await fetch(url,{headers:{"Authorization":"apikey "+env.TWELVE_DATA_API_KEY},signal:AbortSignal.timeout(9000)});
     if(resp.status===429){errors.push({symbol,error:"TWELVE_429"});break}
     if(!resp.ok)throw Error("TWELVE_HTTP_"+resp.status);
     const data=await resp.json();
     if(data.status==="error")throw Error("TWELVE_"+String(data.code||data.message||"API_ERROR").slice(0,75));
     if(!Array.isArray(data.values)||data.values.length<30)throw Error("TWELVE_INSUFFICIENT_BARS");
     const entries=[];
     for(const b of data.values){
       const timestamp=Date.parse(b.datetime.replace(" ","T")+"+03:00");
       const o=Number(b.open),h=Number(b.high),l=Number(b.low),c=Number(b.close),v=Number(b.volume);
       if(!Number.isFinite(timestamp)||!Number.isFinite(o)||!Number.isFinite(h)||!Number.isFinite(l)||!Number.isFinite(c)||!Number.isFinite(v)||o<=0||l<=0||v<0||h<Math.max(o,c,l)||l>Math.min(o,c))continue;
       // Exclude incomplete intraday candle; daily candle only after local market close.
       const duration=interval==="15min"?900000:86400000;
       if(interval==="15min"&&timestamp+duration>Date.now()-120000)continue;
       if(interval==="1day"&&new Date(timestamp).toLocaleDateString("sv-SE",{timeZone:"Europe/Istanbul"})===new Date().toLocaleDateString("sv-SE",{timeZone:"Europe/Istanbul"})&&Number(new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Istanbul",hour:"2-digit",hourCycle:"h23"}).format(new Date()))<19)continue;
       entries.push(env.DB.prepare("INSERT OR IGNORE INTO bist_bridge_bars(symbol,interval,bar_time,open,high,low,close,volume,source,received_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(symbol,interval==="1day"?"1d":"15m",new Date(timestamp).toISOString(),o,h,l,c,v,"Twelve Data XIST / entitlement unverified",new Date().toISOString()));
     }
     if(entries.length){await env.DB.batch(entries);fetched++}
   }catch(e){errors.push({symbol,error:String(e.message||e).slice(0,100)});if(String(e.message||e).includes("429")||String(e.message||e).includes("API credits"))break}
 }
 await env.DB.prepare("INSERT INTO bist_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind("TWELVE_CURSOR_"+interval,String((start+fetched+errors.length)%names.length),new Date().toISOString()).run();
 return {status:errors.length?"PARTIAL_OR_BLOCKED":"FETCH_DONE",requested:symbols.length,fetched,errors,day};
};
const nightRadar=async(env)=>{
 const provider=await ingestTwelve(env,"1day",4);
 const names=await loadBridgeUniverse(env);
 const date=new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Istanbul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
 const kap=await kapPreflight(env),candidates=[],errors=[];
 for(const symbol of names){
   try{
     const bars=await bridgeBars(env,symbol,"1d"),last=bars.at(-1),prior=bars.slice(-21,-1);
     if(!last||prior.length<20)continue;
     const volAvg=prior.reduce((v,x)=>v+x.v,0)/20;
     const rvol=volAvg>0?last.v/volAvg:0;
     const turnover=last.c*last.v;
     const good=turnover>30000000&&last.c>last.o&&rvol>=1.5;
     if(!good)continue;
     candidates.push({symbol,strategy:"SWING",price:last.c,rvol:Number(rvol.toFixed(2)),turnover,bar_timestamp:new Date(last.t*1000).toISOString()});
   }catch(e){const reason=String(e.message||e).slice(0,85);errors.push({symbol,reason});if(reason==="YAHOO_HTTP_429")break}
 }
 candidates.sort((a,b)=>b.rvol-a.rvol);
 for(const c of candidates.slice(0,5)){
   await env.DB.prepare("INSERT INTO watchlist_pool(trade_day,symbol,source,verified,created_at,strategy,metrics_json,radar_status,updated_at) VALUES(?,?,?,0,?,'SWING',?,'RADAR_ONLY',?) ON CONFLICT(trade_day,symbol) DO UPDATE SET metrics_json=excluded.metrics_json,updated_at=excluded.updated_at,radar_status='RADAR_ONLY'")
    .bind(date,c.symbol,"Bridge D1 daily / unverified",new Date().toISOString(),JSON.stringify(c),new Date().toISOString()).run();
 }
 const status=(!names.length||candidates.length===0&&errors.length>0||errors.some(x=>x.reason==="YAHOO_HTTP_429"))?"BLOCKED_MARKET_DATA_UNAVAILABLE":!kap.ready?"NIGHT_OHLCV_OK_KAP_BLOCKED":"NIGHT_OHLCV_OK_KAP_UNVERIFIED";
 const summary={status,provider,scanned:Math.min(names.length,errors.length+candidates.length),universe_count:names.length,market_data_success:Math.max(0,Math.min(names.length,errors.length+candidates.length)-errors.length),candidates:candidates.slice(0,5),errors,kap,approved_signals:0};
 await env.DB.prepare("INSERT OR REPLACE INTO bist_scan_runs(run_id,phase,status,created_at,details) VALUES(?,?,?,?,?)").bind("NIGHT:"+date,"NIGHT_WATCH",status,new Date().toISOString(),JSON.stringify(summary)).run();
 return summary;
};
const hash=async s=>new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s)));
export default {async fetch(request,env){
 const u=new URL(request.url);
 const dashboard=String.raw`<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0b1019"><meta name="referrer" content="no-referrer"><link rel="manifest" href="/manifest.json"><title>BIST AVCI</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0b1019;color:#f2f5fa;font:15px -apple-system,BlinkMacSystemFont,system-ui,sans-serif}main{max-width:720px;margin:auto;padding:20px 17px 100px}header{display:flex;justify-content:space-between;align-items:center;gap:8px}h1{font-size:25px;line-height:1.15;margin:0}h2{font-size:18px;margin:25px 0 12px}p{color:#aeb8c8;margin:5px 0 13px;line-height:1.45}.muted,small{color:#99a5b5;font-size:12px}.badge{border-radius:50px;padding:8px 12px;background:#26313f;color:#ced9e7;font-size:12px}.api{display:flex;gap:7px;flex-wrap:wrap;margin:19px 0}.pill{padding:9px 12px;border:1px solid #374459;border-radius:25px;font-size:12px;color:#ccd5e2;background:#151d2b}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#778394;margin-right:6px}.ok{background:#37d58c;box-shadow:0 0 7px #37d58c}.bad{background:#ff7070}.wait{background:#e6bc50}.panel,.tile{border:1px solid #2d3849;border-radius:17px;padding:17px;background:#151d2b}.hero{background:linear-gradient(125deg,#1c3345,#122332);border:1px solid #365165;border-radius:19px;padding:20px;margin-top:18px}.hero strong{font-size:32px;letter-spacing:-1px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.statgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:12px}.stat{background:#222b3a;border-radius:14px;padding:13px;text-align:center}.stat strong{font-size:23px;display:block}.stat small{font-size:12px}.money{font-size:23px;font-weight:750;margin-top:6px}.empty{padding:18px;border:1px solid #354356;border-radius:15px;color:#a7b5c6;background:#111925;line-height:1.5}.hrow{display:flex;justify-content:space-between;align-items:center;gap:10px}.hrow h2{margin:23px 0 12px}.tabs{display:flex;gap:8px;margin-bottom:12px}.tabs button{width:auto;border-radius:24px;padding:10px 16px;background:#263244}.tabs button.active{background:#32745f}.page{display:none}.page.active{display:block}.nav{position:fixed;z-index:5;bottom:0;left:0;right:0;padding:9px max(10px,env(safe-area-inset-left)) calc(8px + env(safe-area-inset-bottom));background:#111a28;border-top:1px solid #394252;display:flex;justify-content:space-around;gap:4px}.nav button{border:0;background:transparent;flex:1;min-width:0;padding:7px 0;color:#9daabd;font-size:11px;border-radius:10px}.nav button.active{color:#65dfab;background:#213348}.nav b{display:block;font-size:20px;margin-bottom:3px}button{cursor:pointer;border:1px solid #426477;border-radius:11px;padding:12px 14px;background:#226b59;color:white;font-size:14px;font-weight:650}button:disabled{opacity:.6}input{width:100%;background:#0b111c;border:1px solid #56647a;border-radius:11px;padding:14px;color:#fff;font-size:16px;margin:8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0a121e;border-radius:12px;padding:13px;color:#cdd9e7;font-size:12px;max-height:260px;overflow:auto}.warn{color:#e9c782}.subtle{border-top:1px solid #29374a;margin:19px 0 0}.chip{font-size:12px;border:1px solid #45617b;padding:5px 9px;border-radius:20px;color:#aecaee}.cards{display:grid;gap:9px}a{color:#81dccc}@media(min-width:700px){.nav{max-width:720px;margin:auto;border-left:1px solid #394252;border-right:1px solid #394252}}
</style></head><body><main>
<header><div><h1>📈 BIST AVCI</h1><p>Otomatik radar & sanal portföy</p></div><span class="badge" id="mainState">Veri bekleniyor</span></header>
<div class="api"><span class="pill"><i id="geminiDot" class="dot"></i>Gemini · <span id="geminiText">Kontrol bekliyor</span></span><span class="pill"><i id="gptDot" class="dot"></i>GPT · <span id="gptText">Kontrol bekliyor</span></span></div>
<div id="home" class="page active">
<div class="hero"><small>💼 Toplam sanal portföy · başlangıç</small><div><strong id="total">5.000,00 TL</strong></div><p>Gerçekleşen kâr/zarar: <span id="pnl">Henüz işlem yok</span></p></div>
<div class="grid" style="margin-top:11px"><div class="tile"><b>⚡ SCALP</b><div class="money" id="scalpCash">2.500 TL</div><small>Gün içi al-sat kasası</small></div><div class="tile"><b>📈 SWING</b><div class="money" id="swingCash">2.500 TL</div><small>2–3 işlem günü</small></div></div>
<div class="statgrid"><div class="stat"><strong id="scanned">0</strong><small>Taranan</small></div><div class="stat"><strong id="candidates">0</strong><small>👆 Adaylar</small></div><div class="stat"><strong id="approved">0</strong><small>Onaylı</small></div></div>
<div class="hrow"><h2>🎯 Günün İzleme Listesi</h2><small>09:15 bülteni</small></div><div class="empty" id="watchlist" role="button" tabindex="0" data-jump="candidates">Henüz doğrulanmış piyasa verisiyle liste oluşmadı.</div>
<div class="hrow"><h2>⚡ Canlı Radar</h2><small>5 dakikalık döngü</small></div><div class="panel"><div class="hrow"><span>Piyasa veri kaynağı</span><span class="warn" id="marketState">Bağlantı bekleniyor</span></div><div class="hrow" style="margin-top:14px"><span>XU100 savunma</span><span class="warn" id="xuState">Veri bekleniyor</span></div><p class="muted" id="lastRun" style="margin-top:13px">Son tarama: bekleniyor</p></div>
<div class="hrow"><h2>✅ Onaylı Sinyaller</h2><small>En yeniler üstte</small></div><div class="tabs"><button class="active" data-filter="ALL">Tümü</button><button data-filter="SCALP">Günlük</button><button data-filter="SWING">Swing</button></div><div class="empty" id="signalsHome">Henüz onaylı AL / SAT sinyali yok.</div>
<h2>💼 Açık Demo İşlemler</h2><div class="empty" id="openHome">Henüz sanal işlem açılmadı.</div><h2>📊 Performans</h2><div class="empty" id="performanceHome">Gerçek fiyatlarla kapanan sanal işlemler burada gösterilecek.</div>
</div>
<div id="candidates" class="page"><h2>🎯 Pusudaki Adaylar</h2><div class="tabs"><button class="active" data-candidate-filter="ALL">Tümü</button><button data-candidate-filter="SCALP">⚡ Scalp</button><button data-candidate-filter="SWING">📈 Swing</button><button data-candidate-filter="WHALE">🐋 Balina</button></div><p>Gerçek kaynaklardan doğrulanan adaylar burada gösterilir. Aday, AL sinyali değildir.</p><div id="candidateList" class="cards"><div class="empty">Henüz aday yok.</div></div><h2>⚡ SCALP Slotları</h2><div id="scalpSlots" class="cards"></div></div><div id="radar" class="page"><h2>🎯 Radar</h2><p>⚡ Günlük Al-Sat · 📈 Swing · 🐋 Sessiz Balina</p><div class="empty" id="radarState">Doğrulanmış piyasa mum verisi gelmeden otomatik hisse taraması yapılamıyor.</div><h2>Manuel hisse araştırması</h2><div class="panel"><p>Bu bölüm sinyal değildir, mevcut araştırma testidir.</p><input id="symbol" value="ASTOR" maxlength="6" autocapitalize="characters" placeholder="Hisse kodu"><button id="go">Araştır</button><pre id="result">Henüz araştırma yapılmadı.</pre></div></div>
<div id="signals" class="page"><h2>✅ Onaylı Sinyaller</h2><div class="empty" id="signalsPage">Teknik filtre ve resmî risk teyidinden geçmiş sinyal henüz bulunmuyor.</div><p>Bir haberin aramada çıkmaması, risk bulunmadığının kanıtı değildir.</p></div>
<div id="demo" class="page"><h2>💼 Demo Portföy</h2><div class="hero"><small>Başlangıç sanal kasa</small><div><strong id="demoTotal">5.000,00 TL</strong></div><p>SCALP ve SWING kasaları ayrı tutulur. Gerçek banka emri verilmez.</p></div><h2>Açık İşlemler</h2><div class="empty" id="demoOpen">Açık sanal işlem bulunmuyor.</div><h2>Kapanan İşlemler</h2><div class="empty" id="demoClosed">Henüz kapanan işlem yok.</div></div>
<div id="settings" class="page"><h2>⚙️ Ayarlar ve Bağlantılar</h2><div class="panel"><p>Mevcut erişim tokenını girince Gemini, GPT ve radar durumu otomatik kontrol edilir. Token cihazda saklanmaz.</p><input id="token" type="password" autocomplete="off" placeholder="ACCESS_TOKEN"><button id="check">🔌 API bağlantılarını kontrol et</button><pre id="checkResult">Token bekleniyor.</pre><button id="pushOn">🔔 iPhone bildirimlerini etkinleştir</button><pre id="pushStatus">VAPID ve bildirim gönderimi henüz doğrulanmadı.</pre></div><h2>📋 Ortak Teknik Belge</h2><div class="panel"><p>GPT ve Gemini için güncel teknik belge.</p><button id="copyDoc">📋 Teknik belge bağlantısını kopyala</button><p id="copyStatus" class="muted">Gemini sohbetine yapıştırabilirsin.</p></div><h2>🌙 Gece taraması</h2><div class="panel"><p>Son kapanmış günlük mumlarla sistemin kendi testini çalıştır. Onaylı AL sinyali değil, teknik radar testidir.</p><button id="nightTest">🌙 Gece taramasını şimdi çalıştır</button><pre id="nightResult">Henüz bu oturumdan başlatılmadı.</pre></div><h2>Diagnostik</h2><div class="panel"><p>Gemini üretim testleri AI kotası kullanabilir.</p><button id="plain">Basit Gemini testi</button><button id="ground">Gemini Google Search testi</button><pre id="testResult">Henüz test edilmedi.</pre></div></div>
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
async function checkApis(){if(pending)return;pending=true;setDot('gemini','wait','Kontrol');setDot('gpt','wait','Kontrol');try{
const [a,b,c]=await Promise.all([fetch('/bist/connections',{headers:headers()}),fetch('/bist/overview',{headers:headers()}),fetch('/bist/status',{headers:headers()})]);const x=await a.json(),o=await b.json(),status=await c.json();if(a.status===401){setDot('gemini','','Oturum gerekli');setDot('gpt','','Oturum gerekli');document.getElementById('checkResult').textContent='Bir defa erişim tokenı girerek oturum aç.';return}document.getElementById('checkResult').textContent=JSON.stringify(x,null,2);for(const [label,field] of [['gemini','gemini'],['gpt','openai']]){const ok=a.ok&&x[field]&&x[field].connection==='CONNECTED';setDot(label,ok?'ok':'bad',ok?'Bağlı':'Bağlı değil')}if(b.ok){lastData=o;renderOverview(o)}document.getElementById('mainState').textContent=status.scanner_live?'Radar çalışıyor':'Veri bekleniyor';
}catch(e){setDot('gemini','bad','Hata');setDot('gpt','bad','Hata');document.getElementById('checkResult').textContent=String(e.message)}finally{pending=false}}
function renderOverview(d){const cap=Number(d.total_capital||5000);document.getElementById('total').textContent=money(cap);document.getElementById('demoTotal').textContent=money(cap);document.getElementById('scalpCash').textContent=money(cap/2);document.getElementById('swingCash').textContent=money(cap/2);document.getElementById('approved').textContent=String(d.approved||0);document.getElementById('candidates').textContent=String(d.candidates||0);document.getElementById('scanned').textContent=String(d.scanned||0);document.getElementById('lastRun').textContent=d.latest_run?'Son görev: '+d.latest_run.phase+' · '+d.latest_run.status:'Son tarama: bekleniyor';document.getElementById('marketState').textContent='Doğrulanmış veri yok';document.getElementById('xuState').textContent='Veri bekleniyor';document.getElementById('watchlist').textContent=d.candidates>0?'Havuzdaki '+d.candidates+' adayı görmek için dokun →':'Adaylar bölümünü aç → (henüz gerçek veri yok)';
const list=document.getElementById('candidateList');list.replaceChildren();const candidateFilter=document.querySelector('[data-candidate-filter].active')?.dataset.candidateFilter||'ALL';
for(const a of (d.watchlist||[]).filter(x=>candidateFilter==='ALL'||x.strategy===candidateFilter)){const b=document.createElement('button');b.textContent=(a.strategy==='SCALP'?'⚡ SCALP':a.strategy==='SWING'?'📈 SWING':a.strategy==='WHALE'?'🐋 BALİNA':'STRATEJİ BELİRSİZ')+' · '+a.symbol+' · '+(a.verified?'Doğrulandı':'Teyit bekliyor')+' · '+a.source;b.onclick=()=>alert('Hisse: '+a.symbol+'\nKaynak: '+a.source+'\nDurum: '+(a.verified?'Doğrulandı':'Teyit bekliyor')+'\nAL sinyali değildir.');list.append(b)}
if(!list.children.length){const e=document.createElement('div');e.className='empty';e.textContent='Doğrulanmış aday bulunmuyor.';list.append(e)}
const slots=document.getElementById('scalpSlots');slots.replaceChildren();for(const id of [1,2]){const t=(d.open_trades||[]).find(x=>x.strategy==='SCALP'&&x.slot_id===id);const el=document.createElement('div');el.className='tile';el.textContent=t?'Slot '+id+' · '+t.symbol+' · '+t.lot_count+' lot':'Slot '+id+' · Boş · 1.250 TL';slots.append(el)}const o=d.open_trades||[],c=d.closed_trades||[];const openText=o.length?o.map(x=>x.strategy+' · '+x.symbol+' · '+x.lot_count+' lot · '+money(x.executed_price)).join('\n'):'Henüz sanal işlem açılmadı.';document.getElementById('openHome').textContent=openText;document.getElementById('demoOpen').textContent=openText;document.getElementById('demoClosed').textContent=c.length?c.map(x=>x.symbol+' · Net K/Z '+money(x.pnl_net)).join('\n'):'Henüz kapanan işlem yok.';document.getElementById('performanceHome').textContent=c.length?'Kapanan işlem: '+c.length+' · Net toplam: '+money(c.reduce((sum,x)=>sum+Number(x.pnl_net||0),0)):'Henüz kapanan işlem yok.'}
async function loginAndCheck(){if(token.value.trim()){const r=await fetch('/bist/session',{method:'POST',headers:{Authorization:'Bearer '+token.value.trim()}});if(!r.ok){document.getElementById('checkResult').textContent='Erişim tokenı hatalı';return}token.value=''}await checkApis()}token.addEventListener('change',loginAndCheck);document.getElementById('check').onclick=loginAndCheck;checkApis();
document.getElementById('go').onclick=async()=>{const sym=document.getElementById('symbol').value.trim().toUpperCase(),out=document.getElementById('result');if(!/^[A-Z0-9]{3,6}$/.test(sym)){out.textContent='Geçersiz sembol';return}out.textContent='Araştırılıyor';try{const r=await fetch('/bist/research',{method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:JSON.stringify({symbol:sym})});out.textContent='HTTP '+r.status+'\n'+JSON.stringify(await r.json(),null,2)}catch(e){out.textContent=String(e)}};
document.getElementById('nightTest').onclick=async()=>{const b=document.getElementById('nightTest'),o=document.getElementById('nightResult');b.disabled=true;o.textContent='Bot kapanmış mumları tarıyor...';try{const r=await fetch('/bist/night-test',{method:'POST',headers:headers()});const j=await r.json();o.textContent='HTTP '+r.status+'\\n'+JSON.stringify(j,null,2);if(r.ok)await checkApis()}catch(e){o.textContent='Tarama hatası: '+e.message}finally{b.disabled=false}};
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
 if(!authenticated)return reply({error:"Unauthorized"},401);
 const cors={};
 if(u.pathname==="/bist/paper-sizing"&&request.method==="GET"){
  const price=Number(u.searchParams.get("price"));
  if(!Number.isFinite(price)||price<=0)return reply({error:"Valid positive price required"},422);
  const cap=await env.DB.prepare("SELECT value FROM bist_settings WHERE key='TOTAL_CAPITAL'").first();
  const budget=Number(cap?.value||5000)/2;
  return reply({budget,market_price:price,...paperLotPlan(budget,price),note:"Simulation sizing only; actual orders and live price feeds are not connected."});
 }
 if(u.pathname==="/bist/provider/probe"&&request.method==="POST"){
   if(!env.TWELVE_DATA_API_KEY)return reply({status:"NOT_CONFIGURED",required_secret:"TWELVE_DATA_API_KEY"},503);
   try{return reply(await ingestTwelve(env,"1day",1))}catch(e){return reply({status:"PROVIDER_ERROR",detail:String(e.message||e).slice(0,120)},503)}
 }
 if(u.pathname==="/bist/bridge/status"&&request.method==="GET"){const [u,b]=await Promise.all([env.DB.prepare("SELECT COUNT(*) n FROM bist_universe WHERE active=1 AND liquidity_tl>30000000").first(),env.DB.prepare("SELECT COUNT(*) n,MAX(received_at) last_received FROM bist_bridge_bars").first()]);return reply({universe:u?.n||0,bars:b?.n||0,last_received:b?.last_received||null,ready:(u?.n||0)>0&&(b?.n||0)>0})}
 if(["/bist/bridge/import","/bist/feed/ingest"].includes(u.pathname)&&request.method==="POST"){
  if(!env.DB)return reply({error:"DB_MISSING"},503);
  const cl=Number(request.headers.get("Content-Length")||0);if(cl>400000)return reply({error:"PAYLOAD_TOO_LARGE"},413);
  let data;try{data=await request.json()}catch{return reply({error:"BAD_JSON"},400)}
  const symbols=Array.isArray(data.universe)?data.universe:[],bars=Array.isArray(data.bars)?data.bars:[];
  if(symbols.length>150||bars.length>300)return reply({error:"BATCH_TOO_LARGE"},422);
  const validSymbol=x=>/^[A-Z][A-Z0-9]{2,6}$/.test(x||"");
  const statements=[];
  for(const x of symbols){if(!validSymbol(x.symbol)||!["YILDIZ","ANA"].includes(x.market)||!Number.isFinite(x.liquidity_tl)||x.liquidity_tl<0)return reply({error:"INVALID_UNIVERSE_ROW"},422);statements.push(env.DB.prepare("INSERT INTO bist_universe(symbol,market,active,liquidity_tl,source,verified_at) VALUES(?,?,1,?,?,?) ON CONFLICT(symbol) DO UPDATE SET market=excluded.market,liquidity_tl=excluded.liquidity_tl,source=excluded.source,verified_at=excluded.verified_at").bind(x.symbol,x.market,x.liquidity_tl,String(data.source||"external bridge").slice(0,100),new Date().toISOString()))}
  for(const x of bars){if(!validSymbol(x.symbol)||!["15m","1d"].includes(x.interval)||!Number.isFinite(Date.parse(x.time))||Date.parse(x.time)>Date.now()||![x.open,x.high,x.low,x.close,x.volume].every(v=>Number.isFinite(v)&&v>=0)||x.low>x.high||x.open<x.low||x.open>x.high||x.close<x.low||x.close>x.high)return reply({error:"INVALID_BAR"},422);statements.push(env.DB.prepare("INSERT OR IGNORE INTO bist_bridge_bars(symbol,interval,bar_time,open,high,low,close,volume,source,received_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(x.symbol,x.interval,x.time,x.open,x.high,x.low,x.close,x.volume,String(data.source||"external bridge").slice(0,100),new Date().toISOString()))}
  if(!statements.length)return reply({error:"EMPTY_IMPORT"},422);
  await env.DB.batch(statements);return reply({ok:true,universe_rows:symbols.length,bar_rows:bars.length,signals_created:0,orders_sent:0})
 }
 if(u.pathname==="/bist/night-test"&&request.method==="POST"){
  if(!env.DB)return reply({error:"D1 unavailable"},503);
  try{return reply(await nightRadar(env),200)}catch(e){return reply({error:"Night test failed",reason:String(e.message||e).slice(0,130)},503)}
 }
 if(u.pathname==="/bist/overview"&&request.method==="GET"){
   if(!env.DB)return reply({error:"DB unavailable"},503);
   try{
     const results=await Promise.all([
       env.DB.prepare("SELECT value FROM bist_settings WHERE key='TOTAL_CAPITAL'").first(),
       env.DB.prepare("SELECT phase,status,created_at FROM bist_scan_runs ORDER BY created_at DESC LIMIT 1").first(),
       env.DB.prepare("SELECT COUNT(*) AS n FROM watchlist_pool WHERE trade_day=date('now','+3 hours')").first(),
       env.DB.prepare("SELECT symbol,source,strategy,verified,created_at FROM watchlist_pool WHERE trade_day=date('now','+3 hours') ORDER BY verified DESC,created_at DESC LIMIT 5").all(),
       env.DB.prepare("SELECT strategy,slot_id,symbol,lot_count,executed_price,entry_time FROM virtual_trades WHERE status='OPEN' ORDER BY entry_time DESC LIMIT 30").all(),
       env.DB.prepare("SELECT strategy,symbol,pnl_net,exit_time FROM virtual_trades WHERE status='CLOSED' ORDER BY exit_time DESC LIMIT 30").all()
     ]);
     return reply({total_capital:Number(results[0]?.value||5000),latest_run:results[1]||null,candidates:results[2]?.n||0,watchlist:results[3]?.results||[],scanned:0,approved:0,open_trades:results[4]?.results||[],closed_trades:results[5]?.results||[],market_feed_verified:false},200);
   }catch(e){return reply({error:"Dashboard data unavailable",details:String(e).slice(0,110)},503)}
 }
 if(u.pathname==="/push/key"&&request.method==="GET")return reply({key:env.VAPID_PUBLIC_KEY||null,enabled:!!env.VAPID_PUBLIC_KEY},env.VAPID_PUBLIC_KEY?200:503);
 if(u.pathname==="/push/subscribe"&&request.method==="POST"){
   if(!env.DB)return reply({error:"DB yok"},503);
   let sub;try{sub=await request.json()}catch{return reply({error:"Geçersiz JSON"},400)}
   if(typeof sub?.endpoint!=="string"||!/^https:\/\//.test(sub.endpoint)||sub.endpoint.length>2000||typeof sub?.keys?.p256dh!=="string"||typeof sub?.keys?.auth!=="string")return reply({error:"Geçersiz abonelik"},422);
   const allowed=["https://web.push.apple.com/","https://fcm.googleapis.com/","https://updates.push.services.mozilla.com/"];
   if(!allowed.some(x=>sub.endpoint.startsWith(x)))return reply({error:"Desteklenmeyen push servisi"},422);
   try{await env.DB.prepare("INSERT INTO push_subscriptions(endpoint,p256dh,auth,created_at) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth").bind(sub.endpoint,sub.keys.p256dh,sub.keys.auth,new Date().toISOString()).run();return reply({ok:true})}catch{return reply({error:"D1 kayıt hatası"},503)}
 }

 if(u.pathname==="/bist/gemini-test"&&request.method==="GET"){
   const mode=u.searchParams.get("mode");
   if(mode!=="plain"&&mode!=="grounding")return reply({error:"Invalid test mode"},422);
   const payload={contents:[{parts:[{text:"Reply in Turkish with exactly: BAGLANTI TESTI BASARILI"}]}],generationConfig:{temperature:0,maxOutputTokens:90}};
   if(mode==="grounding")payload.tools=[{google_search:{}}];
   try{
     const r=await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",{method:"POST",headers:{"x-goog-api-key":env.GEMINI_API_KEY||"","Content-Type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});
     if(!r.ok){let e={};try{e=await r.json()}catch{}return reply({mode,provider_http:r.status,status:"FAILED",provider_code:e.error?.status||null,provider_message:String(e.error?.message||"").slice(0,350)},200)}
     const j=await r.json();return reply({mode,provider_http:r.status,status:"SUCCESS",answer:(j.candidates?.[0]?.content?.parts||[]).map(x=>x.text||"").join("").slice(0,500),grounding_chunks:j.candidates?.[0]?.groundingMetadata?.groundingChunks?.length||0},200);
   }catch{return reply({mode,status:"TIMEOUT_OR_NETWORK_ERROR"},200)}
 }
 if(u.pathname==="/bist/connections"&&request.method==="GET"){
   const inspect=async(url,headers)=>{
     try{const r=await fetch(url,{headers,signal:AbortSignal.timeout(9000)});return {http:r.status,connection:r.ok?"CONNECTED":r.status===401||r.status===403?"INVALID_OR_FORBIDDEN":r.status===429?"RATE_LIMITED":"HTTP_ERROR"}}
     catch{return {connection:"NETWORK_ERROR"}}
   };
   const [gemini,openai]=await Promise.all([
     inspect("https://generativelanguage.googleapis.com/v1beta/models",{"x-goog-api-key":env.GEMINI_API_KEY||""}),
     inspect("https://api.openai.com/v1/models",{"Authorization":"Bearer "+(env.OPENAI_API_KEY||"")})
   ]);
   return reply({gemini,openai,notice:"Model listesi erişimi araştırma üretim kotasını veya Search Grounding yetkisini doğrulamaz.",keys_exposed:false},200);
 }

 if(u.pathname==="/bist/status"&&request.method==="GET")
   return reply({service:"BIST AVCI research",ready:!!env.GEMINI_API_KEY,mode:"manual",scanner_live:false,market_data_connected:false,kap_feed_connected:false,orders:false,grounding:"search-is-not-KAP-verification"},200,cors);
 if(u.pathname==="/bist/research"&&request.method==="POST"){
   if(!(request.headers.get("Content-Type")||"").includes("application/json"))return reply({error:"JSON gerekli"},415,cors);
   if(Number(request.headers.get("Content-Length")||0)>1024)return reply({error:"Istek buyuk"},413,cors);
   let data;try{data=await request.json()}catch{return reply({error:"JSON gecersiz"},400,cors)}
   const symbol=String(data.symbol||"").trim().toUpperCase();
   if(!/^[A-Z0-9]{3,6}$/.test(symbol))return reply({error:"Sembol gecersiz"},422,cors);
   if(!env.DB||!env.GEMINI_API_KEY)return reply({error:"Servis hazir degil"},503,cors);
   const day=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Istanbul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
   const stamp=new Date().toISOString();
   const db=env.DB;
   // One SQLite write statement claims the symbol and available daily slot together.
   // D1 serializes writes; a same-day UNIQUE(day,symbol) prevents duplicate calls.
   // FAILED reservations do not count against the five daily slots.
   try{
     const previous=await db.prepare("SELECT status,response_json FROM bist_research_cache WHERE day=? AND symbol=?").bind(day,symbol).first();
     if(previous?.status==="DONE"&&previous.response_json)return reply({...JSON.parse(previous.response_json),cached:true},200,cors);
     if(previous?.status==="RESERVED")return reply({symbol,status:"NEWS_REVIEW_PENDING",technical_score_only:true},202,cors);
     const claim=await db.prepare(
       "INSERT INTO bist_research_cache(day,symbol,status,created_at,attempts) "+
       "SELECT ?,?,'RESERVED',?,1 WHERE (SELECT COUNT(*) FROM bist_research_cache WHERE day=? AND status IN ('RESERVED','DONE')) < 20 "+
       "ON CONFLICT(day,symbol) DO UPDATE SET status='RESERVED',response_json=NULL,created_at=excluded.created_at,attempts=bist_research_cache.attempts+1 "+
       "WHERE bist_research_cache.status='FAILED' AND bist_research_cache.attempts<3 AND "+
       "(SELECT COUNT(*) FROM bist_research_cache WHERE day=? AND status IN ('RESERVED','DONE')) < 20"
     ).bind(day,symbol,stamp,day,day).run();
     if(claim.meta?.changes!==1){
       const current=await db.prepare("SELECT status,response_json,attempts FROM bist_research_cache WHERE day=? AND symbol=?").bind(day,symbol).first();
       if(current?.status==="DONE"&&current.response_json)return reply({...JSON.parse(current.response_json),cached:true},200,cors);
       if(current?.status==="RESERVED")return reply({symbol,status:"NEWS_REVIEW_PENDING",technical_score_only:true},202,cors);
       if(current?.status==="FAILED"&&Number(current.attempts)>=3)return reply({symbol,status:"RETRY_LIMIT",attempts:current.attempts,limit:3,day},429,cors);
       return reply({status:"DAILY_LIMIT",limit:20,day},429,cors);
     }
   }catch{return reply({status:"NEWS_REVIEW_PENDING",error:"Rezervasyon basarisiz"},503,cors)}
   const fail=async(reason)=>{
     // Failed claims stop occupying a daily slot; no separate counter to refund.
     try{await db.prepare("UPDATE bist_research_cache SET status='FAILED' WHERE day=? AND symbol=? AND status='RESERVED'").bind(day,symbol).run()}catch{}
     return reply({symbol,status:"NEWS_REVIEW_PENDING",technical_score_only:true,reason},202,cors);
   };
   try{
     const prompt="Turkce cevap ver. Sembol: "+symbol+". Web arama, canli fiyat, KAP ve teknik gosterge verisi SAGLANMADI. Sirketle ilgili genel sektor dinamiklerini, temel risk kategorilerini, bilanço incelenirken bakilacak kalemleri ve teknik gorunumu degerlendirmek icin gereken EMA200, VWAP, RVOL, XU100 goreceli guc verilerini acikla. Hicbir guncel haber, guncel fiyat, teknik gosterge degeri, alim/satim sinyali veya kaynak UYDURMA. Guncel haber durumu: DOGRULANAMADI. Kisa ve somut yaz.";
     const url="https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent";
     const r=await fetch(url,{method:"POST",headers:{"x-goog-api-key":env.GEMINI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt}]}],generationConfig:{temperature:0.2,maxOutputTokens:600}}),signal:AbortSignal.timeout(15000)});
     if(!r.ok){let detail="";try{const err=await r.json();detail=String(err.error?.message||err.error?.status||"").slice(0,180)}catch{}return await fail("GEMINI_HTTP_"+r.status+(detail?": "+detail:""));}
     const j=await r.json(),candidate=j.candidates?.[0]||{};
     const answer=(candidate.content?.parts||[]).map(p=>p.text||"").join("").slice(0,4000);
     const citations=(candidate.groundingMetadata?.groundingChunks||[]).filter(x=>x.web?.uri).slice(0,8).map(x=>({title:x.web.title||"",url:x.web.uri}));
     const result={symbol,status:"UNVERIFIED_AI_COMMENTARY",answer,citations:[],officialKapVerified:false,technical_score_only:true,grounding_enabled:false,orders:false};
     await db.prepare("UPDATE bist_research_cache SET status='DONE',response_json=? WHERE day=? AND symbol=? AND status='RESERVED'").bind(JSON.stringify(result),day,symbol).run();
     return reply(result,200,cors);
   }catch{return await fail("TIMEOUT_OR_PROVIDER_ERROR")}
 }

 return reply({error:"Not found"},404);
},async scheduled(event,env,ctx){
 const task=async()=>{
   const local=new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Istanbul",hour:"2-digit",minute:"2-digit",weekday:"short",hourCycle:"h23"}).formatToParts(new Date(event.scheduledTime||Date.now()));
   const get=k=>local.find(x=>x.type===k)?.value||"";
   const h=Number(get("hour")),m=Number(get("minute")),day=get("weekday");
   const weekday=!["Sat","Sun"].includes(day);
   let phase="SKIPPED";
   if(h===23&&m===30)phase="NIGHT_WATCH";
   else if(h===9&&m===15)phase="MORNING_WATCH";
   else if(weekday&&h*60+m>=615&&h*60+m<=1035)phase="INTRADAY_SCAN";
   if(phase==="SKIPPED")return;
   const id=new Date(event.scheduledTime||Date.now()).toISOString();
   // Fail closed: no licensed or verified live BIST / KAP feed is configured.
   // Never manufacture bars, risk clearances, trading signals or paper fills.
   let status="BLOCKED_MISSING_VERIFIED_FEED",results=[],kap={ready:false};
   if(phase==="NIGHT_WATCH"){await nightRadar(env);return}
   if(phase==="INTRADAY_SCAN"){
     const provider=await ingestTwelve(env,"15min",4);
     const symbols=await loadBridgeUniverse(env);
     kap=await kapPreflight(env);
     for(const symbol of symbols){
       try{
         const bars=await bridgeBars(env,symbol,"15m");
         const m=technicalCandidate(bars);
         if(!m||!m.passed||m.volumeTL<30000000)continue;
         results.push({symbol,...m});
         const tradeDay=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Istanbul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
         await env.DB.prepare("INSERT INTO watchlist_pool(trade_day,symbol,source,verified,created_at,strategy,metrics_json,radar_status,updated_at) VALUES(?,?,?,0,?,'SCALP',?,'RADAR_ONLY',?) ON CONFLICT(trade_day,symbol) DO UPDATE SET metrics_json=excluded.metrics_json,updated_at=excluded.updated_at,radar_status='RADAR_ONLY'").bind(tradeDay,symbol,"Bridge D1 intraday / unverified",new Date().toISOString(),JSON.stringify(m),new Date().toISOString()).run();
       }catch(e){const reason=String(e.message||e);console.log("FEED_SKIP",symbol,reason.slice(0,80));if(reason==="YAHOO_HTTP_429")break}
     }
     status=kap.ready?"TECHNICAL_RADAR_KAP_UNVERIFIED":"TECHNICAL_RADAR_KAP_BLOCKED";
   }else status="BLOCKED_MISSING_VERIFIED_FEED";
   try{
    await env.DB.prepare("INSERT OR IGNORE INTO bist_scan_runs(run_id,phase,status,created_at,details) VALUES(?,?,?,?,?)")
      .bind(id,phase,status,new Date().toISOString(),JSON.stringify({market_data_source:"D1 bridge / Twelve optional",provider,kap,technical_candidates:results.length,verified_market_data:false,verified_kap:false,signals_created:0,orders_sent:0})).run();
   }catch(e){console.error("scan log error",String(e).slice(0,100))}
 };
 ctx.waitUntil(task());
}};
