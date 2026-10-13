"""Bounded loopback UDP ingestion. No generated bars, no broker orders."""
import datetime as dt,json,math,re,socket,threading,time,uuid
UTC=dt.timezone.utc

def iso(t):return dt.datetime.fromtimestamp(t,UTC).isoformat(timespec='milliseconds').replace('+00:00','Z')
def numeric(s,positive=False):
    if isinstance(s,bool):raise ValueError('INVALID_NUMBER')
    v=float(str(s).replace(',','.'))
    if not math.isfinite(v) or v<0 or positive and v<=0:raise ValueError('INVALID_NUMBER')
    return v

def symbol(s,universe):
    s=s.strip().upper().removeprefix("IMKBH'")
    if not re.fullmatch('[A-Z0-9]{3,6}',s) or s not in universe:raise ValueError('UNKNOWN_SYMBOL')
    return s

def parse(line,universe,now):
    p=line.strip().split(';')
    # Existing 3-field stream is observable, but cannot prove source age.
    if len(p)==3:
        return dict(kind='QUOTE',symbol=symbol(p[0],universe),price=numeric(p[1],True),source_time=iso(now),clock_basis='LOCAL_RECEIPT',entry_eligible=False,cumulative_volume=numeric(p[2]),volume_unit='UNKNOWN')
    if p[0]=='Q' and len(p)==9:
        t=dt.datetime.fromisoformat(p[4].replace('Z','+00:00')).timestamp()
        if not p[4].endswith('Z') or not 0<=now-t<=15:raise ValueError('STALE_SOURCE_POLL')
        return dict(kind='QUOTE',symbol=symbol(p[1],universe),price=numeric(p[2],True),source_time=p[4],clock_basis='SOURCE_POLL',entry_eligible=True,turnover_tl=numeric(p[3]),lot_day=numeric(p[5]),limit_up=numeric(p[6],True),previous_close=numeric(p[7],True),sequence=int(p[8]))
    if p[0]=='B' and len(p)==11:
        s=symbol(p[1],universe);interval=p[2]
        if interval not in ('1m','15m','60m','1d'):raise ValueError('INVALID_INTERVAL')
        start=dt.datetime.fromisoformat(p[3].replace('Z','+00:00')).timestamp();end=dt.datetime.fromisoformat(p[4].replace('Z','+00:00')).timestamp()
        seconds={'1m':60,'15m':900,'60m':3600,'1d':86400}[interval]
        if not p[3].endswith('Z') or not p[4].endswith('Z') or end>now or end-start!=seconds or now-start>800*86400 or interval!='1d' and start%seconds not in ((0,1800) if interval=='60m' else (0,)) or p[10]!='LOT':raise ValueError('INVALID_CLOSED_BAR')
        o,h,l,c=[numeric(x,True) for x in p[5:9]]
        if not l<=min(o,c)<=max(o,c)<=h:raise ValueError('INVALID_OHLC')
        return dict(kind='BAR',symbol=s,interval=interval,bar_time=p[3],bar_close_time=p[4],source_time=iso(now),closed=True,open=o,high=h,low=l,close=c,volume=numeric(p[9]),volume_unit='LOT',bar_origin='IDEAL_OFFICIAL_HISTORY')
    raise ValueError('INVALID_PACKET_FORMAT')

class Ingress:
    def __init__(self,store,root):
        self.store=store;self.root=root
        self.universe=set(re.split(r'[,;\s]+',(root/'SymbolsCsv.txt').read_text(encoding='utf-8-sig').strip()))
        self.universe.discard('');self.latest={};self.sequences={};self.lock=threading.Lock();self.last_batch=0;self.stats=dict(received=0,rejected=0,accepted=0,last_error=None,last_received_at=None,transport='IDEAL_UDP',paper_only=True)
    def receive(self,data,peer,now=None):
        now=time.time() if now is None else now
        if peer[0]!='127.0.0.1' or len(data)>60000:raise ValueError('LOCAL_ONLY')
        lines=data.decode('utf-8-sig',errors='strict').splitlines()
        if not 1<=len(lines)<=100:raise ValueError('INVALID_BATCH')
        events=[parse(line,self.universe,now) for line in lines if line.strip()]
        with self.lock:
            for e in events:
                if e['kind']=='QUOTE':
                    seq=e.get('sequence');key=e['symbol'];prev=self.sequences.get(key)
                    if seq is not None and prev is not None and seq<=prev:continue
                    if seq is not None:self.sequences[key]=seq
                    self.latest[key]=e
                else:
                    self.store.accept(dict(source='IDEAL_UDP',version=1,packet_id='IDEAL:'+uuid.uuid4().hex,events=[e]),now)
                    self.stats['accepted']+=1
            self.stats['received']+=len(events);self.stats['last_received_at']=iso(now)
    def flush(self,now=None):
        now=time.time() if now is None else now
        with self.lock:
            values=list(self.latest.values());self.latest.clear()
        for i in range(0,len(values),100):
            r=self.store.accept(dict(source='IDEAL_UDP',version=1,packet_id='IDEAL:'+uuid.uuid4().hex,events=values[i:i+100]),now)
            self.stats['accepted']+=r['accepted']
        # Preserve newest quotes and bars; bound ingress backlog to 10 minutes.
        # Runtime/trials lagging beyond this window must wait for current data.
        if now-self.last_batch>60:
            with self.store.lock,self.store.db:
                self.store.db.execute('DELETE FROM events WHERE received_at<? AND id<(SELECT max(id) FROM events)',(now-600,))
                self.store.db.execute('DELETE FROM packets WHERE received_at<?',(now-600,))
                self.store.db.execute("DELETE FROM bars WHERE interval IN ('1m','15m') AND received_at<?",(now-7*86400,))
            self.last_batch=now
    def status(self):
        with self.store.lock:
            bars=self.store.db.execute('SELECT interval,count(DISTINCT symbol),count(*) FROM bars GROUP BY interval').fetchall()
        return {**self.stats,'bar_coverage':[dict(interval=i,symbols=n,bars=b) for i,n,b in bars],'known_symbols':len(self.universe),'source_age_note':'Q timestamps are poll times, not exchange transaction timestamps','legacy_3_fields':'RADAR_ONLY_NO_ENTRY'}

def start_udp(store,settings,root):
    listener=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
    if hasattr(socket,'SO_EXCLUSIVEADDRUSE'):listener.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
    listener.bind(('127.0.0.1',5555));listener.settimeout(.1)
    ingress=Ingress(store,root)
    store.accept(dict(source='IDEAL_UDP',version=1,packet_id='IDEAL:UNIVERSE:'+uuid.uuid4().hex,events=[dict(kind='UNIVERSE',symbols=sorted(ingress.universe),source_time=iso(time.time()))]))
    def run():
        last=time.time()
        while True:
            try:
                data,peer=listener.recvfrom(60001);ingress.receive(data,peer)
            except socket.timeout:pass
            except (ValueError,UnicodeError,OverflowError,TypeError) as e:
                ingress.stats['rejected']+=1;ingress.stats['last_error']=str(e)[:100]
            except Exception as e:
                ingress.stats['last_error']=type(e).__name__
            now=time.time()
            if now-last>=1:
                try:ingress.flush(now)
                except Exception as e:ingress.stats['last_error']='STORE_'+type(e).__name__
                last=now
    threading.Thread(target=run,name='ideal-udp',daemon=True).start()
    print('iDeal UDP dinleniyor: 127.0.0.1:5555 | Durum: http://127.0.0.1:9001/ideal-status',flush=True)
    return ingress
