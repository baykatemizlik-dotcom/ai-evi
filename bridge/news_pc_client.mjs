const iso=n=>new Date(n).toISOString();
export async function setupNewsSelection(db){for(const sql of [
 'CREATE TABLE IF NOT EXISTS news_pc_rank_choices(signal_key TEXT PRIMARY KEY,rank INTEGER NOT NULL,role TEXT NOT NULL,confidence INTEGER NOT NULL,reason TEXT NOT NULL,expires_at TEXT NOT NULL)',
 'CREATE TABLE IF NOT EXISTS news_pc_risk_meta(id INTEGER PRIMARY KEY,valid_until TEXT NOT NULL,source_as_of TEXT NOT NULL)'])await db.prepare(sql).run();}
export async function refreshNewsRisk(db,cloudCall,wall=Date.now()){
 let r;try{r=await cloudCall('/bist/news/guardian');}catch(e){if(e.message!=='PANEL_HTTP_503')throw e;await cloudCall('/bist/news/run',{mode:'COLLECT'});r=await cloudCall('/bist/news/guardian');}if(r.verified!==true||r.source!=='https://www.borsaistanbul.com/erd/menkul_tedbir_listesi.csv'||!Array.isArray(r.symbols)||r.symbols.length<400||!Array.isArray(r.eligible_symbols)||!Number.isFinite(Date.parse(r.valid_until))||!Number.isFinite(Date.parse(r.as_of))||Date.parse(r.valid_until)<=wall||Date.parse(r.valid_until)>wall+16*60000||Math.abs(Date.parse(r.as_of)-wall)>120000)throw Error('NEWS_OFFICIAL_RISK_NOT_FRESH');
 const safe=new Set(r.eligible_symbols);if(r.symbols.some(s=>!/^[A-Z0-9]{3,6}$/.test(s))||[...safe].some(s=>!r.symbols.includes(s)))throw Error('INVALID_NEWS_RISK_UNIVERSE');
 await db.batch([...r.symbols.map(s=>db.prepare('INSERT INTO bist_funnel_risk VALUES(?,?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET eligible=excluded.eligible,as_of=excluded.as_of,valid_until=excluded.valid_until,source=excluded.source').bind(s,safe.has(s)?1:0,r.as_of,r.valid_until,r.source)),db.prepare('INSERT INTO news_pc_risk_meta VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET valid_until=excluded.valid_until,source_as_of=excluded.source_as_of').bind(r.valid_until,r.source_as_of)]);
 return r;
}
export async function newsPcQueue(db,rows,evaluation,wall=Date.now()){
 const meta=await db.prepare('SELECT valid_until FROM news_pc_risk_meta WHERE id=1').first();if(!meta||Date.parse(meta.valid_until)<=wall)return [];
 const choices=await db.prepare('SELECT * FROM news_pc_rank_choices WHERE expires_at>?').bind(iso(evaluation)).all(),map=new Map(choices.results.map(r=>[r.signal_key,r]));
 return rows.filter(r=>map.has(r.signal_key)&&map.get(r.signal_key).role!=='WATCH').sort((a,b)=>map.get(a.signal_key).rank-map.get(b.signal_key).rank).map(r=>({...r,news_role:map.get(r.signal_key).role,news_rank:map.get(r.signal_key).rank,reason:'Mini '+(map.get(r.signal_key).role==='PRIMARY'?'öncelikli':'yedek')+' #'+map.get(r.signal_key).rank+': '+map.get(r.signal_key).reason}));
}
export async function requestPcRanking(db,cloudCall,evaluation,wall=Date.now()){
 const rows=await db.prepare("SELECT * FROM edge_candidates WHERE status IN('GEMINI_APPROVED_AWAITING_RANK','APPROVED') AND bar_time>=? ORDER BY bar_time DESC,wall_observed_at ASC LIMIT 100").bind(iso(evaluation-30*60000)).all(),open=await db.prepare("SELECT symbol FROM virtual_trades WHERE strategy='SCALP' AND status='OPEN'").all(),held=new Set(open.results.map(r=>r.symbol)),seen=new Set(),candidates=[];
 for(const c of rows.results){if(seen.has(c.symbol)||held.has(c.symbol)||evaluation-(Date.parse(c.bar_time)+900000)>900000||Date.parse(c.bar_time)+900000>evaluation)continue;const risk=await db.prepare('SELECT * FROM bist_funnel_risk WHERE symbol=? AND eligible=1 AND valid_until>?').bind(c.symbol,iso(wall)).first();if(!risk)continue;seen.add(c.symbol);const metrics=JSON.parse(c.metrics_json);candidates.push({...c,score:Number(metrics.score||0),risk});if(candidates.length===10)break;}
 if(!candidates.length)return null;
 const r=await cloudCall('/bist/news/rank/pc',{mode:'DELAYED_DEMO_15M',evaluation_time:iso(evaluation),candidates});
 if(!['VALIDATED','CACHED','BLACKLISTED'].includes(r.status))return {error:'MINI_'+r.status,items:[],requested:candidates};
 if(!Array.isArray(r.items))throw Error('INVALID_PC_RANKING_RESPONSE');const allowed=new Map(candidates.map(c=>[c.signal_key,c])),used=new Set();
 for(const row of r.items){if(!allowed.has(row.signal_key)||allowed.get(row.signal_key).symbol!==row.symbol||used.has(row.signal_key)||!['PRIMARY','BACKUP','WATCH'].includes(row.role)||!Number.isInteger(row.rank)||row.rank<1||row.rank>10||typeof row.approved!=='boolean'||!Number.isInteger(row.confidence)||row.confidence<0||row.confidence>100||typeof row.reason!=='string'||row.reason.length>350)throw Error('INVALID_PC_RANKING_RESPONSE');used.add(row.signal_key);}
 return {...r,requested:candidates};
}
export async function applyPcRanking(db,result,evaluation,wall=Date.now()){
 if(!result||result.error)return;const rows=result.items||[],byKey=new Map(rows.map(r=>[r.signal_key,r])),statements=[];
 for(const c of result.requested){const r=byKey.get(c.signal_key);if(evaluation-(Date.parse(c.bar_time)+900000)>900000)continue;
  const approved=!!r&&r.approved&&r.confidence>=70&&r.role!=='WATCH',reason=r?.reason||'OFFICIAL_BLACKLIST',role=approved?r.role:'WATCH';
  statements.push(db.prepare('INSERT INTO news_pc_rank_choices VALUES(?,?,?,?,?,?) ON CONFLICT(signal_key) DO UPDATE SET rank=excluded.rank,role=excluded.role,confidence=excluded.confidence,reason=excluded.reason,expires_at=excluded.expires_at').bind(c.signal_key,r?.rank||10,role,r?.confidence||0,reason,iso(evaluation+900000)));
  statements.push(db.prepare('UPDATE edge_candidates SET status=?,reason=? WHERE signal_key=?').bind(approved?'APPROVED':'REJECTED','Mini '+role+': '+reason,c.signal_key));
  statements.push(db.prepare("INSERT INTO bist_ai_decisions(signal_key,run_id,symbol,bar_time,model,status,reason,created_at,completed_at) VALUES(?,'EDGE',?,?,'gpt-4o-mini',?,?,?,?) ON CONFLICT(signal_key) DO UPDATE SET status=excluded.status,reason=excluded.reason,completed_at=excluded.completed_at").bind(c.signal_key,c.symbol,c.bar_time,approved?'APPROVED':'REJECTED',reason,iso(evaluation),iso(evaluation)));
  if(approved)statements.push(db.prepare("INSERT OR IGNORE INTO scalp_sniper_queue VALUES(?,?,?,?,?,?,'READY',?,?)").bind(c.signal_key,c.symbol,c.bar_time,iso(evaluation),iso(evaluation+900000),JSON.parse(c.metrics_json).score,'MINI_'+role+': '+reason,c.metrics_json));
 }if(statements.length)await db.batch(statements);
}
