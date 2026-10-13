"""Add the news selection hook to an existing PC install; preserve all ledgers."""
from pathlib import Path
import shutil,datetime,os

def patch(runtime,engines):
    if 'news_pc_client.mjs' in runtime:return runtime,engines
    required=["async function reviewOne(now)","async function applyReview()","let busy=false,aiBusy=false,pendingReview=null;","if(!aiBusy){aiBusy=true;reviewOne(wall-900000)","const feed=new DatabaseSync"]
    if any(x not in runtime for x in required) or ' for(const q of qrows.results||[])' not in engines:raise ValueError('INCOMPATIBLE_VERSION_NO_FILES_CHANGED')
    runtime="import {setupNewsSelection,refreshNewsRisk,requestPcRanking,applyPcRanking,newsPcQueue} from './news_pc_client.mjs';\n"+runtime
    runtime=runtime.replace('const feed=new DatabaseSync','await setupNewsSelection(db);\nconst feed=new DatabaseSync',1)
    runtime=runtime.replace("{method:'POST',redirect:'error'","{method:body===undefined?'GET':'POST',redirect:'error'",1)
    runtime=runtime.replace("mode:'DELAYED_DEMO_15M'});","mode:'DELAYED_DEMO_15M',review_stage:'GEMINI_ONLY'});",1)
    start=runtime.index('async function applyReview()');ends=[runtime.find(x,start) for x in ['function saveStatus(', 'function atomicJson(']];end=min(x for x in ends if x>=0)
    replacement='''async function applyReview(){if(!pendingReview)return;const {c,v}=pendingReview;pendingReview=null;
 sql.prepare('INSERT OR IGNORE INTO edge_ai VALUES(?,?)').run(c.signal_key,JSON.stringify(v));
 const status=v.approved?'GEMINI_APPROVED_AWAITING_RANK':v.error?'AI_ERROR':'REJECTED';sql.prepare('UPDATE edge_candidates SET status=?,reason=? WHERE signal_key=?').run(status,v.error||v.reason||status,c.signal_key);
 if(!v.approved)return;const observed=Date.now()-900000;if(observed-(Date.parse(c.bar_time)+900000)>900000)return;
 await db.prepare("INSERT OR IGNORE INTO bist_gemini_decisions VALUES(?,'EDGE',?,?,'gemini-3.1-flash-lite','APPROVED',?,?,?)").bind(c.signal_key,c.symbol,c.bar_time,v.confidence||0,v.reason||'GEMINI_APPROVED',iso(observed)).run();
}
'''
    runtime=runtime[:start]+replacement+runtime[end:]
    runtime=runtime.replace('let busy=false,aiBusy=false,pendingReview=null;','let busy=false,aiBusy=false,pendingReview=null,newsBusy=false,pendingNews=null,lastNewsAttempt=0,lastRiskAttempt=0,lastAiAttempt=0;')
    runtime=runtime.replace(' await applyReview();',' await applyReview();\n if(pendingNews){const result=pendingNews;pendingNews=null;await applyPcRanking(db,result,Date.now()-900000);}',1)
    runtime=runtime.replace(' if(!aiBusy){aiBusy=true;reviewOne(wall-900000)', ' if(!newsBusy&&wall-lastNewsAttempt>=60000){lastNewsAttempt=wall;newsBusy=true;(async()=>{if(wall-lastRiskAttempt>=600000){lastRiskAttempt=wall;await refreshNewsRisk(db,cloudCall,wall);}const result=await requestPcRanking(db,cloudCall,Date.now()-900000);if(result?.error)cloudError=result.error;else if(result)pendingNews=result;})().catch(e=>{cloudError=String(e.message).slice(0,120);}).finally(()=>{newsBusy=false;});}\n if(!aiBusy&&wall-lastAiAttempt>=60000){lastAiAttempt=wall;aiBusy=true;reviewOne(wall-900000)',1)
    queue="data.scalp_sniper_queue=sql.prepare(\"SELECT * FROM scalp_sniper_queue WHERE status='READY' AND expires_at>? ORDER BY score DESC LIMIT 100\").all(iso(now));"
    if queue in runtime:runtime=runtime.replace(queue,"data.scalp_sniper_queue=await newsPcQueue(db,sql.prepare(\"SELECT * FROM scalp_sniper_queue WHERE status='READY' AND expires_at>? ORDER BY score DESC LIMIT 100\").all(iso(now)),now);",1)
    runtime=runtime.replace("['APPROVED','AWAITING_TWO_AI'].includes(c.status)","['APPROVED','AWAITING_TWO_AI','GEMINI_APPROVED_AWAITING_RANK'].includes(c.status)")
    engines="import {newsPcQueue} from './news_pc_client.mjs';\n"+engines
    engines=engines.replace(' for(const q of qrows.results||[]){'," const newsRows=strategy==='SCALP'?await newsPcQueue(db,qrows.results||[],now):qrows.results||[];\n for(const q of newsRows){",1)
    return runtime,engines

def main():
    root=Path(__file__).resolve().parent;runtime=root/'runtime.mjs';engines=root/'engines.mjs'
    if not runtime.exists() or not engines.exists():raise SystemExit('Bu dosyalari mevcut BASLAT klasorune koy. runtime.mjs ve engines.mjs bulunamadi.')
    before=runtime.read_text(encoding='utf-8');old=engines.read_text(encoding='utf-8');new,new_engine=patch(before,old)
    if new==before:print('Haber secimi zaten kurulmus.');return
    backup=root/('news_backup_'+datetime.datetime.now().strftime('%Y%m%d_%H%M%S'));backup.mkdir()
    for p in [runtime,engines]:shutil.copy2(p,backup/p.name)
    for p,value in [(runtime,new),(engines,new_engine)]:
        temp=p.with_suffix(p.suffix+'.news-tmp');temp.write_text(value,encoding='utf-8');os.replace(temp,p)
    print('Kuruldu. BASLAT kapaliysa yeniden ac. Veritabanlari ve connection.json degismedi. Yedek:',backup.name)

if __name__=='__main__':
    try:main()
    except Exception as e:raise SystemExit(str(e)) from None
