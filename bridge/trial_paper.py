"""Isolated, event-ordered Yahoo 1m PAPER adapters. Never sends broker orders.

Research ancestry V4QQ/V4PT; frozen installation models, delayed observed feed,
current official risk eligibility. These are not identical historical replays.
"""
import copy, datetime as dt, json, math, time, urllib.parse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from decimal import Decimal as D
from pathlib import Path
import numpy as np
from bist_sync import request_json, worker_call

FEE=D('.0004');BUY=D('1.001');SELL=D('.999')
UTC=dt.timezone.utc


def stamp(m):
    return dt.datetime.fromtimestamp((m-180)*60,UTC).isoformat(timespec='milliseconds').replace('+00:00','Z')


def predict(model,v):
    if model['kind']=='RIDGE':
        return model['intercept']+sum((x-u)/s*c for x,u,s,c in zip(v,model['mean'],model['scale'],model['coef']))
    v=np.asarray(v,dtype=np.float32);values=[]
    for t in model['trees']:
        i=0
        while t['left'][i]!=-1:i=t['left'][i] if v[t['feature'][i]]<=t['threshold'][i] else t['right'][i]
        values.append(t['value'][i])
    return sum(values)/len(values)


def yahoo_minutes(symbol,now):
    url='https://query1.finance.yahoo.com/v8/finance/chart/'+symbol+'.IS?'+urllib.parse.urlencode({'interval':'1m','range':'5d','includePrePost':'false'})
    chart=request_json(url,timeout=15,attempts=2).get('chart') or {};rs=chart.get('result') or []
    if not rs:raise ValueError('YAHOO_NO_DATA')
    r=rs[0];meta=r.get('meta',{})
    if meta.get('currency')!='TRY' or meta.get('instrumentType')!='EQUITY' or meta.get('dataGranularity')!='1m':raise ValueError('INVALID_SOURCE')
    confirmed=min(now,meta.get('regularMarketTime',0));q=(r.get('indicators',{}).get('quote') or [{}])[0];bars={}
    for i,t in enumerate(r.get('timestamp') or []):
        if t%60 or t+60>confirmed:continue
        v=[(q.get(k) or [])[i] if i<len(q.get(k) or []) else None for k in ('open','high','low','close','volume')]
        if any(isinstance(x,bool) or not isinstance(x,(float,int)) or not math.isfinite(x) for x in v):continue
        o,h,l,c,vol=v
        if min(o,h,l,c)<=0 or vol<0 or not l<=min(o,c)<=max(o,c)<=h:continue
        m=int(t//60)+180
        if 600<=m%1440<1080:bars[m]=v
    return bars


def references_before(ref,bars,day):
    r=copy.deepcopy(ref)
    # Update only entire prior days after the immutable seed; no current day inputs.
    for d in sorted({m//1440 for m in bars if m//1440<day and m>ref['last_minute']}):
        seq=sorted(m for m in bars if m//1440==d);start=d*1440+600
        if not seq:continue
        if start in bars and start+1 in bars:r['opening_volumes']=(r['opening_volumes']+[bars[start][4]+bars[start+1][4]])[-20:]
        for c in range(630,991,15):
            keys=range(d*1440+c-10,d*1440+c)
            if all(m in bars for m in keys):r['clock_volumes'][str(c)]=(r['clock_volumes'][str(c)]+[sum(bars[m][4] for m in keys)])[-20:]
        if len(seq)>=400:
            close=bars[seq[-1]][3];hi=max(bars[m][1] for m in seq);lo=min(bars[m][2] for m in seq);prev=r['daily_close']
            if prev:r['daily']=(r['daily']+[[max(hi-lo,abs(hi-prev),abs(lo-prev))/prev,(hi-lo)/prev,close/prev-1]])[-20:]
            r['daily_close']=close
        r['previous_close']=bars[seq[-1]][3]
    return r


def breadth(data,m):
    vals=[bars[m-1][3]>bars[m//1440*1440+600][0] for bars in data.values() if m-1 in bars and m//1440*1440+600 in bars]
    return (sum(vals)/len(vals),len(vals)) if vals else (0,0)


def features(symbol,bars,ref,m,ratio):
    clock=m%1440;start=m//1440*1440+600
    if clock==602:
        if not all(k in bars for k in (start,start+1)):return None
        g=[bars[start],bars[start+1]];prior=ref['opening_volumes']
    elif clock in range(630,991,15):
        if not all(k in bars for k in range(m-30,m)) or start not in bars:return None
        g=[bars[k] for k in range(m-10,m)];prior=ref['clock_volumes'][str(clock)]
    else:return None
    if len(prior)<10 or np.mean(prior)<=0:return None
    o=g[0][0];c=g[-1][3];hi=max(v[1] for v in g);lo=min(v[2] for v in g);vol=sum(v[4] for v in g)
    if hi<=lo:return None
    f={'symbol':symbol,'minute':m,'close':c,'rvol':vol/float(np.mean(prior)),'gain':c/o-1,'body':(c-o)/(hi-lo),'wick':(hi-c)/(hi-lo),'turnover':sum(v[3]*v[4] for v in g),'market_breadth':{'ratio':ratio}}
    if clock==602:
        prev=ref['previous_close'];gap=o/prev-1
        main=ratio>=.4 and -.02<=gap<=.03 and .006<=f['gain']<=.03 and f['body']>=.85 and f['wick']<=.15 and f['turnover']>=15000000 and f['rvol']>=2
        repair=-.08<=gap<=-.02 and .005<=f['gain']<=.03 and f['body']>=.6 and f['wick']<=.2 and f['turnover']>=3000000 and f['rvol']>=1 and c<prev
        if not (main or repair):return None
        f['source']='OPENING_MAIN' if main else 'OPENING_GAP';f['score']=f['rvol']*f['body']/(1+f['gain']/.015);return f
    if not (.004<=f['gain']<=.03 and f['body']>=.65 and f['wick']<=.2 and f['turnover']>=2000000 and f['rvol']>=1.5):return None
    prefix=[v for k,v in bars.items() if start<=k<m];total=sum(v[4] for v in prefix)
    if total<=0:return None
    f['vwap']=sum(v[3]*v[4] for v in prefix)/total;f['prior_range_high']=max(bars[k][1] for k in range(m-30,m-10))
    if c<=f['vwap'] or c<=f['prior_range_high']:return None
    f['source']='INTRADAY';return f


def model_vector(f,ref,atr):
    m=f['minute'];v=[math.log1p(f['rvol']),math.log1p(f['turnover']),f['gain'],f['body'],f['wick'],f['market_breadth']['ratio'],(m%1440-600)/480,f['close']/f['prior_range_high']-1,f['close']/f['vwap']-1]
    if atr:
        h=ref['daily']
        if len(h)<10:return None
        a=float(np.mean([x[0] for x in h]));returns=[x[2] for x in h]
        v += [a,float(np.mean([x[1] for x in h])),float(np.std(returns)),float(np.prod([1+x for x in returns[-5:]])-1),float(np.prod([1+x for x in returns])-1),.03/max(.001,a),(1078-m%1440)/480]
    return v


def reconcile(s):
    cash=D(s['initial_cash']);held={};pnl=D(0)
    for e in s['ledger']:
        assert int(e['lot_count'])==e['lot_count'] and e['lot_count']>=2
        if e['side']=='BUY':
            assert not held and e['symbol'] not in held
            cost=D(e['executed_price'])*e['lot_count']+D(e['commission']);assert cost<=cash
            cash-=cost;held[e['symbol']]=cost
        else:
            cost=held.pop(e['symbol']);net=D(e['executed_price'])*e['lot_count']-D(e['commission']);cash+=net;pnl+=net-cost
        assert cash>=0 and cash==D(e['cash_after'])
    assert cash==D(s['cash']) and pnl==D(s['realised_pnl']) and len(held)==len(s['open_trades'])


def reduce_minute(s,bars,m,candidates,received):
    cash=D(s['cash']);pos=s['open_trades'][0] if s['open_trades'] else None
    def close(raw,reason):
        nonlocal cash,pos
        price=D(str(raw))*SELL;fee=price*pos['lot_count']*FEE;net=price*pos['lot_count']-fee;cost=D(pos['entry_cost']);pnl=net-cost;cash+=net
        event={'side':'SELL','symbol':pos['symbol'],'lot_count':pos['lot_count'],'executed_price':str(price),'commission':str(fee),'cash_after':str(cash),'source_time':stamp(m),'observed_at':received}
        s['ledger'].append(event);s['closed_trades'].append({**pos,'exit_time':stamp(m),'exit_observed_at':received,'exit_price':str(price),'exit_reason':reason,'pnl_net':str(pnl)})
        s['realised_pnl']=str(D(s['realised_pnl'])+pnl);s['open_trades']=[];pos=None
    if pos:
        b=bars.get(pos['symbol'],{}).get(m)
        if b:
            o,hi,lo,c,_=map(lambda x:D(str(x)),b);stop=D(pos['stop']);tp=D(pos['tp'])
            if m//1440>pos['entry_minute']//1440 or m%1440>=1078:close(o,'EOD_OR_NEXT_AVAILABLE_OPEN')
            elif o<=stop:close(o,'GAP_SL')
            elif o>=tp:close(o,'TP_OPEN')
            elif lo<=stop:close(stop,'SL_STOP_FIRST')
            elif hi>=tp:close(tp,'TP_FULL')
            elif m-pos['high_minute']>=45:close(o,'IDLE_45_ACTIVE_MINUTES')
            else:
                if hi>D(pos['high']):pos['high']=str(hi);pos['high_minute']=m
                pos['current_price']=str(c)
    if not pos and m%1440<1078:
        # Sorted only by completed prior bars/model; never by next Open or outcome.
        for f in candidates:
            b=bars.get(f['symbol'],{}).get(m)
            if not b:continue
            fill=D(str(b[0]))*BUY;lots=int(cash/(fill*(1+FEE)))
            if lots<2:continue
            fee=fill*lots*FEE;cost=fill*lots+fee;cash-=cost
            pos={'symbol':f['symbol'],'entry_minute':m,'entry_time':stamp(m),'entry_observed_at':received,'executed_price':str(fill),'lot_count':lots,'commission':str(fee),'entry_cost':str(cost),'stop':str(fill*D('.985')),'tp':str(fill*D('1.03')),'high':str(fill),'high_minute':m,'current_price':str(b[3]),'signal_source':f['source'],'model_score':f.get('score')}
            s['open_trades']=[pos];s['ledger'].append({'side':'BUY','symbol':pos['symbol'],'lot_count':lots,'executed_price':str(fill),'commission':str(fee),'cash_after':str(cash),'source_time':stamp(m),'observed_at':received})
            # Entry Open followed by same minute's path, stop wins ambiguous bars.
            if D(str(b[2]))<=D(pos['stop']):close(D(pos['stop']),'ENTRY_BAR_SL_STOP_FIRST')
            elif D(str(b[1]))>=D(pos['tp']):close(D(pos['tp']),'ENTRY_BAR_TP_FULL')
            else:
                if D(str(b[1]))>fill:pos['high']=str(b[1]);pos['high_minute']=m
            break
    s['cash']=str(cash);s['cursor']=m
    s['equity']=str(cash+sum(D(p['current_price'])*p['lot_count']*SELL*(1-FEE) for p in s['open_trades']))
    reconcile(s)


def main():
    bundle=json.loads(Path(__file__).with_name('trial_models.json').read_text());now=time.time();received=dt.datetime.fromtimestamp(now,UTC).isoformat(timespec='milliseconds').replace('+00:00','Z');day=int(now//60+180)//1440
    state=worker_call('/bist/feed/trials');data={};failures=0
    symbols=sorted(bundle['references'])
    with ThreadPoolExecutor(max_workers=12) as pool:
        futures={pool.submit(yahoo_minutes,s,now):s for s in symbols}
        for future in as_completed(futures):
            try:data[futures[future]]=future.result()
            except Exception:failures+=1
    refs={sym:references_before(bundle['references'][sym],bars,day) for sym,bars in data.items()}
    risk={r['symbol'] for r in state.get('risk',[]) if r['eligible']==1 and r['valid_until']>received}
    counts=defaultdict(int)
    for bars in data.values():
        for m in bars:
            if m//1440==day:counts[m]+=1
    eligible_minutes=sorted(m for m,n in counts.items() if n>=400)
    latest=max(eligible_minutes,default=None);coverage=sum(any(m//1440==day for m in b) for b in data.values())
    cache={};opening_refs={}
    for row in state['bots']:
        s={k:v for k,v in row.items() if k not in ('id','revision','updated_at','panel_stale')};model=bundle['models'][s['arm']];s.update(last_received_at=received,scanned_symbols=coverage,fetch_failed=failures,model_kind=model['kind'],training_rows=model['training_rows'],model_trained_through=bundle['trained_through'],candidates=0)
        if latest is None:s['status']='WAITING_TODAY_DATA' if coverage==0 else 'BLOCKED_INCOMPLETE_UNIVERSE'
        elif now-(latest-180)*60>35*60:s['status']='BLOCKED_STALE_DATA'
        else:
            s['status']='RUNNING_DELAYED_PAPER' if risk else 'BLOCKED_RISK_DATA'
            diagnostics=dict(s.get('daily_diagnostics') or {})
            if diagnostics.get('day')!=day:diagnostics={'day':day,'technical_pass':0,'risk_rejected':0,'model_rejected':0,'entry_candidates':0,'processed_minutes':0}
            poll={'technical_pass':0,'risk_rejected':0,'model_rejected':0,'entry_candidates':0,'processed_minutes':0}
            minimum=max(s.get('cursor') or 0,s['source_start_minute'])
            for m in eligible_minutes:
                if m<minimum or m<= (s.get('cursor') or 0):continue
                if m not in cache:
                    ratio,n=breadth(data,m);cache[m]=[]
                    if n>=400:
                        for sym,b in data.items():
                            f=features(sym,b,refs[sym],m,ratio)
                            if f:cache[m].append(f)
                candidates=[]
                poll['processed_minutes']+=1;poll['technical_pass']+=len(cache[m])
                for f in cache[m]:
                    if f['symbol'] not in risk:poll['risk_rejected']+=1;continue
                    f=dict(f)
                    if f['source']=='INTRADAY':
                        ref=refs[f['symbol']];v=model_vector(f,ref,model['atr'])
                        baseline=predict(bundle['models']['V4PT'],model_vector(f,ref,False))
                        score=predict(model,v) if v is not None else None
                        primary=score is not None and score>=(.001 if model['atr'] else .003)
                        if model['atr']:primary=primary and .02<=v[9]<=1 and f['market_breadth']['ratio']>=.4 and v[12]>=-1 if v is not None else False
                        # V4QQ retains V4PT's entire schedule, not just opening bars.
                        if not primary and not (model['atr'] and baseline>=.003):poll['model_rejected']+=1;continue
                        f['score']=score if primary else baseline
                    candidates.append(f)
                candidates.sort(key=lambda f:('INTRADAY'!=f['source'] if m%1440!=602 else f['source']!='OPENING_MAIN',-f['score'],-f['turnover'],f['symbol']))
                poll['entry_candidates']+=len(candidates)
                s['candidates']+=len(candidates);reduce_minute(s,data,m,candidates,received)
            s['last_source_time']=stamp(latest)
            for k,v in poll.items():diagnostics[k]=diagnostics.get(k,0)+v
            s['daily_diagnostics']=diagnostics;s['last_poll_diagnostics']=poll
            s['no_entry_reason']='MODEL_SCORE_BELOW_ENTRY_THRESHOLD' if poll['model_rejected'] else 'NO_TECHNICAL_CANDIDATE' if not poll['entry_candidates'] else 'CANDIDATES_EVALUATED'
            s['entry_score_threshold']=.001 if model['atr'] else .003
        reconcile(s)
        result=worker_call('/bist/feed/trials',{'id':row['id'],'expected_revision':row['revision'],'state':s})
        print(json.dumps({'id':row['id'],'status':s['status'],'scanned':coverage,'fetch_failed':failures,'source':s.get('last_source_time'),'cash':s['cash'],'open':len(s['open_trades']),'closed':len(s['closed_trades']),'saved':result.get('ok')},allow_nan=False))


if __name__=='__main__':main()
