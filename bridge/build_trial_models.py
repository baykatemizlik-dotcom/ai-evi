"""Export trusted research labels/models and prior-only volume references as JSON.

No pickle, secrets, or realised winner whitelist is exported. Run only locally
against the verified research packages/cache; runtime consumes JSON only.
"""
import argparse, hashlib, json, zipfile
from pathlib import Path
import numpy as np
from sklearn.ensemble import ExtraTreesRegressor
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


def vector(s, atr=False):
    v=[np.log1p(s['rvol']),np.log1p(s['turnover']),s['gain'],s['body'],s['wick'],s['market_breadth']['ratio'],(s['minute']%1440-600)/480,s['close']/s['prior_range_high']-1,s['close']/s['vwap']-1]
    if atr:
        v += [s['prior_atr_pct'],s['prior_range_pct'],s['prior_return_std'],s['prior_return5'],s['prior_return20'],.03/max(.001,s['prior_atr_pct']),(1078-s['minute']%1440)/480]
    return list(map(float,v))


def main():
    p=argparse.ArgumentParser();p.add_argument('--base',required=True);p.add_argument('--atr',required=True);p.add_argument('--cache',required=True);p.add_argument('--output',required=True);a=p.parse_args()
    out={'schema':1,'trained_through':'2026-10-09','mode':'YAHOO_DELAYED_PAPER_ADAPTATION','models':{},'references':{},'limitations':['Models frozen at installation; research results not live proof.','Yahoo corporate-action/provider differences may invalidate historical references.','No historical backfilled entries before installation.']}
    for name,path,filename,atr in [('V4PT',a.base,'learning_labels_180.json',False),('V4QQ',a.atr,'atr_learning_labels_180.json',True)]:
        with zipfile.ZipFile(path) as z:
            rows=json.loads(z.read('shared_research/runs/V4/'+filename))
        cutoff=int(np.datetime64('2026-10-12','m').astype(int))
        rows=[r for r in rows if r['signal']['minute']<cutoff and r['target_known_minute']<cutoff]
        assert len(rows)>=200
        X=np.array([vector(r['signal'],atr) for r in rows]);y=np.array([r['target'] for r in rows])
        if atr:
            m=ExtraTreesRegressor(n_estimators=32,max_depth=5,min_samples_leaf=30,random_state=4,n_jobs=1).fit(X,y)
            trees=[]
            for e in m.estimators_:
                t=e.tree_;trees.append({'left':t.children_left.tolist(),'right':t.children_right.tolist(),'feature':t.feature.tolist(),'threshold':t.threshold.tolist(),'value':t.value[:,0,0].tolist()})
            exported={'kind':'EXTRA_TREES','trees':trees}
            def predict(v):
                v=np.asarray(v,dtype=np.float32);values=[]
                for t in trees:
                    i=0
                    while t['left'][i]!=-1:i=t['left'][i] if v[t['feature'][i]]<=t['threshold'][i] else t['right'][i]
                    values.append(t['value'][i])
                return sum(values)/len(values)
        else:
            m=make_pipeline(StandardScaler(),Ridge(alpha=20)).fit(X,y);sc=m[0];r=m[1]
            exported={'kind':'RIDGE','mean':sc.mean_.tolist(),'scale':sc.scale_.tolist(),'coef':r.coef_.tolist(),'intercept':float(r.intercept_)}
            def predict(v):return exported['intercept']+sum((x-u)/s*c for x,u,s,c in zip(v,exported['mean'],exported['scale'],exported['coef']))
        err=max(abs(predict(v)-w) for v,w in zip(X[:200],m.predict(X[:200])));assert err<1e-12
        exported.update(training_rows=len(rows),label_horizon=180,latest_label_minute=max(r['target_known_minute'] for r in rows),export_max_error=err,atr=atr)
        out['models'][name]=exported
    cache=Path(a.cache)
    for r in json.loads((cache/'manifest.json').read_text()):
        if r['status']!='LOADED':continue
        z=np.load(cache/(r['symbol']+'.npz'));ts,vs=z['times'],z['values'];opening=[];clocks={str(c):[] for c in range(630,991,15)};daily=[];prev=None
        for day in np.unique(ts//1440):
            start=int(day)*1440+600;i=int(np.searchsorted(ts,start));idx=np.flatnonzero(ts//1440==day)
            if i+2<=len(ts) and np.array_equal(ts[i:i+2],np.arange(start,start+2)):opening.append(float(vs[i:i+2,4].sum()))
            for c in range(630,991,15):
                m=int(day)*1440+c;j=int(np.searchsorted(ts,m-10))
                if j+10<=len(ts) and np.array_equal(ts[j:j+10],np.arange(m-10,m)):clocks[str(c)].append(float(vs[j:j+10,4].sum()))
            if len(idx)>=400:
                g=vs[idx];close=float(g[-1,3]);hi=float(g[:,1].max());lo=float(g[:,2].min())
                if prev is not None:daily.append([max(hi-lo,abs(hi-prev),abs(lo-prev))/prev,(hi-lo)/prev,close/prev-1])
                prev=close
        out['references'][r['symbol']]={'opening_volumes':opening[-20:],'clock_volumes':{k:v[-20:] for k,v in clocks.items()},'daily':daily[-20:],'daily_close':prev,'previous_close':float(vs[-1,3]),'last_minute':int(ts[-1])}
    text=json.dumps(out,separators=(',',':'),allow_nan=False);Path(a.output).write_text(text)
    print(json.dumps({'symbols':len(out['references']),'models':{k:{x:v[x] for x in ('training_rows','export_max_error','kind')} for k,v in out['models'].items()},'sha256':hashlib.sha256(text.encode()).hexdigest(),'bytes':len(text)}))


if __name__=='__main__':main()
