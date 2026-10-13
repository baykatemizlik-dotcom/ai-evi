"""Update an installed news-enabled motor in place, preserving all DBs and secrets."""
from pathlib import Path
import datetime as dt,json,os,shutil,socket,subprocess,sqlite3

def once(text,old,new):
    if text.count(old)!=1:raise ValueError('SURUM_UYUMSUZ: '+old[:65])
    return text.replace(old,new,1)

def patch(runtime,engines,receiver):
    if "source_provider:'IDEAL_UDP'" in runtime:return runtime,engines,receiver
    if 'news_pc_client.mjs' not in runtime:raise ValueError('HABER_YAMASI_BULUNAMADI: once mevcut haber kurulumu tamamlanmali')
    runtime=once(runtime,"sql.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');","sql.exec('PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL;');")
    runtime="import {migrateIdealQuotes} from './ideal_schema.mjs';\n"+runtime
    runtime=once(runtime,"const cfg=settings();","migrateIdealQuotes(sql);\nconst cfg=settings();")
    runtime=once(runtime,"if(cfg.delay_seconds!==900)throw Error('THIS_PACKAGE_IS_DELAYED_DEMO_ONLY');","if(cfg.delay_seconds!==0||cfg.source_provider!=='IDEAL_UDP')throw Error('IDEAL_CONFIG_REQUIRED');")
    runtime=runtime.replace('wall-900000','wall').replace('Date.now()-900000','Date.now()')
    runtime=runtime.replace('MATRIKSIQ_DELAYED_DEMO','IDEAL_LIVE').replace('DELAYED_DEMO_15M','IDEAL_LIVE_PAPER')
    runtime=once(runtime,"if(e.kind==='UNIVERSE')return;","if(e.kind==='UNIVERSE')return;\n if(row.packet_id&&!row.packet_id.startsWith('IDEAL:'))return;\n if(e.kind==='QUOTE'&&e.entry_eligible!==true)return;")
    runtime=once(runtime,'await assess(e.symbol,now);',"if(e.entry_eligible===true&&now-(idealAssessed.get(e.symbol)||0)>=30000){idealAssessed.set(e.symbol,now);await assess(e.symbol,now);}")
    runtime=once(runtime,'let busy=false,aiBusy=false,pendingReview=null', 'const idealAssessed=new Map();\nlet busy=false,aiBusy=false,pendingReview=null')
    runtime=once(runtime,"await fillStrategy(db,'SCALP',now);await fillStrategy(db,'SWING',now);","if(e.entry_eligible===true&&sql.prepare(\"SELECT symbol FROM scalp_sniper_queue WHERE status='READY' UNION ALL SELECT symbol FROM trend_radar_queue WHERE status='READY' LIMIT 1\").get()){await fillStrategy(db,'SCALP',now);await fillStrategy(db,'SWING',now);}")
    # Legacy un-timestamped lines can update radar only, never execution or exits.
    runtime=once(runtime,"await manageScalp(db,now,e.symbol);await manageTrend(db,now,e.symbol);","if(e.entry_eligible!==true)return;\n if(sql.prepare(\"SELECT id FROM virtual_trades WHERE symbol=? AND status='OPEN' LIMIT 1\").get(e.symbol)){await manageScalp(db,now,e.symbol);await manageTrend(db,now,e.symbol);}")
    runtime=runtime.replace("SELECT id,payload,received_at FROM events", "SELECT id,packet_id,payload,received_at FROM events")
    runtime=once(runtime,"version:1,mode:'IDEAL_LIVE_PAPER',paper_only:true","version:1,source_provider:'IDEAL_UDP',expected_delay_seconds:0,mode:'IDEAL_LIVE_PAPER',paper_only:true")
    runtime=once(runtime,"'Yerel Scalp/Trend demo motoru başladı. Gerçek emir yok; kayıtlar ayrı yerel defterde.'","'iDeal canlı veri / yerel SANAL Scalp-Trend motoru başladı. Aracı kuruma emir gönderilmez.'")
    # New source must not replay pending candidates from the delayed feed.
    runtime=once(runtime,"const cfg=settings();", "const cfg=settings();\nsql.exec(\"CREATE TABLE IF NOT EXISTS ideal_boot(name TEXT PRIMARY KEY);\");\nif(!sql.prepare(\"SELECT name FROM ideal_boot WHERE name='v1'\").get()){sql.prepare(\"INSERT INTO edge_control VALUES('activation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value\").run(String(Date.now()));sql.exec(\"UPDATE edge_candidates SET status='EXPIRED',reason='SOURCE_CHANGED_TO_IDEAL' WHERE status IN ('AWAITING_TWO_AI','GEMINI_APPROVED_AWAITING_RANK','APPROVED'); UPDATE scalp_sniper_queue SET status='EXPIRED',reason='SOURCE_CHANGED_TO_IDEAL' WHERE status='READY'; UPDATE trend_radar_queue SET status='EXPIRED',reason='SOURCE_CHANGED_TO_IDEAL' WHERE status='READY'; INSERT INTO ideal_boot VALUES('v1');\");}\n")
    runtime=once(runtime,"const t=Date.parse(e.source_time);","if(e.previous_close>0){const yesterday=iso(wall-86400000).slice(0,10)+'T00:00:00.000Z';sql.prepare('INSERT INTO strategy_market_context VALUES(?,?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET session_date=excluded.session_date,previous_close=excluded.previous_close,previous_bar_time=excluded.previous_bar_time,received_at=excluded.received_at').run(e.symbol,trtDate(wall),e.previous_close,yesterday,iso(wall));}\n const t=Date.parse(e.source_time);")
    runtime=once(runtime,'for(const r of rows){',"sql.exec('BEGIN IMMEDIATE');try{for(const r of rows){")
    runtime=once(runtime,"engineError=null;if(wall-lastSnapshot","}finally{sql.exec('COMMIT');}\n engineError=null;if(wall-lastSnapshot")
    engines=engines.replace('MATRIKSIQ_DELAYED_DEMO','IDEAL_LIVE')
    receiver=once(receiver,"packet.get('source') != 'MATRIKSIQ_LIVE'", "packet.get('source') not in ('MATRIKSIQ_LIVE','IDEAL_UDP')")
    receiver=once(receiver,"store = Store(ROOT / 'matriks_feed.sqlite', settings['delay_seconds'])", "store = Store(ROOT / 'matriks_feed.sqlite', settings['delay_seconds'])\n    from ideal_udp import start_udp\n    ideal_ingress = start_udp(store,settings,ROOT)")
    receiver=once(receiver,"if self.path == '/status':", "if self.path == '/ideal-status': return self.reply(ideal_ingress.status())\n            if self.path == '/status':")
    receiver=once(receiver,"if self.path != '/events':", "if settings.get('source_provider')=='IDEAL_UDP': return self.reply({'error':'USE_IDEAL_UDP'},409)\n            if self.path != '/events':")
    receiver=receiver.replace('Matriks bağlantısı bekleniyor:', 'iDeal bağlantısı bekleniyor:').replace('IQ Algo LocalToken parametresi için connection.json dosyasını açın.', 'iDeal ALGO gondericisi 127.0.0.1:5555 adresini kullanmali.')
    receiver=receiver.replace('MatriksIQ → Yerel veri köprüsü','iDeal → Yerel UDP köprüsü').replace('Matriks · Yerel demo motorları','iDeal · Canlı veri / sanal motorlar').replace('15 dakika gecikmeli demo.','iDeal canlı veri, sanal işlem motoru.').replace('LIVE_DATA_CONNECTION_TEST','IDEAL_LIVE_PAPER')
    return runtime,engines,receiver

def main(root=None):
    root=Path(root) if root else Path(__file__).resolve().parent
    if (root/'runtime.mjs').exists() is False:raise ValueError('KURULUM_DOSYALARINI_BASLAT_KLASORUNE_KOY')
    for port in (9001,5555):
        s=socket.socket(socket.AF_INET,socket.SOCK_STREAM if port==9001 else socket.SOCK_DGRAM)
        try:s.bind(('127.0.0.1',port))
        except OSError:raise ValueError('ONCE_BASLAT_VE_ESKI_UDP_DINLEYICIYI_KAPAT: '+str(port))
        finally:s.close()
    names=['runtime.mjs','engines.mjs','receiver.py'];values=[(root/n).read_text(encoding='utf-8-sig') for n in names]
    new=patch(*values)
    if new==tuple(values):print('iDeal zaten kurulu. IDEAL_BASLAT.bat kullan.');return
    # All syntax checks happen before replacing installed files.
    temps=[]
    try:
        for name,value in zip(names,new):
            p=root/(name+'.ideal-check'+('.mjs' if name.endswith('.mjs') else '.py'));p.write_text(value,encoding='utf-8');temps.append(p)
            if name.endswith('.mjs'):subprocess.run(['node','--check',str(p)],check=True,capture_output=True)
            else:compile(value,str(p),'exec')
    finally:
        for p in temps:p.unlink(missing_ok=True)
    news_path=root/'news_pc_client.mjs';news_old=news_path.read_text(encoding='utf-8-sig');news_new=news_old.replace("mode:'DELAYED_DEMO_15M'","mode:'IDEAL_LIVE_PAPER'");names.append('news_pc_client.mjs');values.append(news_old);new=(*new,news_new)
    cfg_path=root/'connection.json';cfg=json.loads(cfg_path.read_text(encoding='utf-8-sig'));cfg.update(delay_seconds=0,source_provider='IDEAL_UDP')
    backup=root/('ideal_backup_'+dt.datetime.now().strftime('%Y%m%d_%H%M%S'));backup.mkdir()
    if (root/'engine.sqlite').exists():
        with sqlite3.connect(root/'engine.sqlite',timeout=10) as origin,sqlite3.connect(backup/'engine.sqlite') as target:origin.backup(target)
    for name in [*names,'connection.json']:shutil.copy2(root/name,backup/name)
    try:
        for name,value in [*zip(names,new),('connection.json',json.dumps(cfg,indent=2))]:
            p=root/name;t=p.with_suffix(p.suffix+'.ideal-tmp');t.write_text(value,encoding='utf-8');os.replace(t,p)
    except Exception:
        for name in [*names,'connection.json']:shutil.copy2(backup/name,root/name)
        raise
    bridge=Path(os.environ.get('LOCALAPPDATA',str(root)))/'AI_Evi'/'ideal_bridge';bridge.mkdir(parents=True,exist_ok=True);shutil.copy2(root/'SymbolsCsv.txt',bridge/'symbols.txt')
    print('iDeal kuruldu. Defterler/haberler/tokenlar korundu. Yedek:',backup.name)
    print('IDEAL_BASLAT.bat ac; iDeal formulu etkinlestir; http://127.0.0.1:9001/ideal-status kontrol et.')
if __name__=='__main__':
    try:main()
    except Exception as e:raise SystemExit('Kurulum durdu: '+str(e)) from None
