// BIST AVCI paper execution module. No broker actions.
// Returns deterministic net proceeds. Constants preserve configured 3% price TP / 1.5% price SL.
export function planEntry(cash, rawPrice, slotLimit=1250){
 const budget=Math.min(cash,slotLimit),execution=rawPrice*1.002,unitCost=execution*1.002;
 const lots=Math.max(0,Math.floor(budget/unitCost));
 return {lots,executedPrice:execution,entryCommission:execution*lots*0.002,totalCost:unitCost*lots};
}
export function planExit(entry, rawPrice){
 const sell=rawPrice*0.998,fee=sell*entry.lot_count*0.002;
 const proceeds=sell*entry.lot_count-fee;
 const netPnl=proceeds-(entry.executed_price*entry.lot_count+entry.commission);
 const reason=rawPrice>=entry.executed_price*1.03?'TP_3_PCT':rawPrice<=entry.executed_price*0.985?'STOP_1_5_PCT':null;
 return {reason,exitPrice:sell,commission:fee,proceeds,pnlNet:netPnl};
}
// Operates only if upstream explicitly verified market+disclosures. D1 batch executes transactionally.
export async function openPaperScalp(db,signal){
 if(signal?.verifiedMarket!==true||signal?.verifiedRisk!==true)return {ok:false,reason:'NOT_VERIFIED'};
 const {symbol,price,barTime}=signal;
 if(!/^[A-Z][A-Z0-9]{2,6}$/.test(symbol||'')||!Number.isFinite(price)||price<=0||!Number.isFinite(Date.parse(barTime))||Math.abs(Date.now()-Date.parse(barTime))>20*60000)return {ok:false,reason:'STALE_OR_INVALID'};
 const current=await db.prepare("SELECT available_cash FROM paper_cash_accounts WHERE strategy='SCALP'").first();
 const occupied=await db.prepare("SELECT slot_id FROM virtual_trades WHERE strategy='SCALP' AND status='OPEN'").all();
 const used=new Set(occupied.results.map(t=>t.slot_id)),slot=[1,2].find(v=>!used.has(v));
 if(!slot)return {ok:false,reason:'SLOTS_FULL'};
 const plan=planEntry(Number(current?.available_cash||0),price);
 if(plan.lots<1)return {ok:false,reason:'NO_CASH'};
 const stamp=new Date().toISOString();
 // INSERT first; conditional debit succeeds iff exactly one INSERT occurred.
 const tx=await db.batch([
  db.prepare("INSERT INTO virtual_trades(strategy,symbol,signal_price,executed_price,lot_count,commission,entry_time,status,slot_id) SELECT 'SCALP',?,?,?,?,?,?,'OPEN',? WHERE (SELECT available_cash FROM paper_cash_accounts WHERE strategy='SCALP')>=? AND NOT EXISTS(SELECT 1 FROM virtual_trades WHERE strategy='SCALP' AND status='OPEN' AND (symbol=? OR slot_id=?))")
   .bind(symbol,price,plan.executedPrice,plan.lots,plan.entryCommission,stamp,slot,plan.totalCost,symbol,slot),
  db.prepare("UPDATE paper_cash_accounts SET available_cash=available_cash-?,updated_at=? WHERE strategy='SCALP' AND changes()=1 AND available_cash>=?")
   .bind(plan.totalCost,stamp,plan.totalCost)
 ]);
 if(tx[0].meta?.changes!==1||tx[1].meta?.changes!==1)return {ok:false,reason:'CONCURRENT_OR_NO_CASH'};
 return {ok:true,symbol,slot,lots:plan.lots,totalCost:plan.totalCost};
}
export async function closePaperScalp(db,trade,verifiedPrice,barTime){
 if(!trade||trade.strategy!=='SCALP'||trade.status!=='OPEN'||!Number.isFinite(verifiedPrice)||verifiedPrice<=0||Math.abs(Date.now()-Date.parse(barTime))>20*60000)return {ok:false,reason:'INVALID_MARKET'};
 const e=planExit(trade,verifiedPrice);
 if(!e.reason)return {ok:false,reason:'NO_EXIT'};
 const stamp=new Date().toISOString();
 const tx=await db.batch([
  db.prepare("UPDATE virtual_trades SET status='CLOSED',exit_price=?,exit_time=?,exit_reason=?,pnl_net=? WHERE id=? AND strategy='SCALP' AND status='OPEN'").bind(e.exitPrice,stamp,e.reason,e.pnlNet,trade.id),
  db.prepare("UPDATE paper_cash_accounts SET available_cash=available_cash+?,updated_at=? WHERE strategy='SCALP' AND changes()=1").bind(e.proceeds,stamp)
 ]);
 return tx[0].meta?.changes===1&&tx[1].meta?.changes===1?{ok:true,...e}:{ok:false,reason:'ALREADY_SETTLED'};
}
