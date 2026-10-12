"""One bounded paper-feed session, then a same-workflow handoff.

Only the existing configured credentials are used. No broker orders, cash
resets, model changes or other workflow dispatches. Weekday/session bounded.
"""
import datetime as dt
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT=Path(__file__).resolve().parent
INTERVAL=300
DURATION=25*60


def market_window(epoch):
    d=dt.datetime.fromtimestamp(epoch,ZoneInfo('Europe/Istanbul'))
    return d.weekday()<5 and 600<=d.hour*60+d.minute<1120


def next_delay(start,end,interval=INTERVAL):
    return max(0,interval-(end-start))


def run_session(clock=time.time,sleep=time.sleep,run=subprocess.run):
    began=clock();n=0
    while market_window(clock()) and clock()-began<DURATION:
        start=clock();n+=1
        print(json.dumps({'event':'TRIAL_POLL_START','cycle':n,'at':dt.datetime.fromtimestamp(start,dt.timezone.utc).isoformat(),'interval_seconds':INTERVAL}),flush=True)
        try:
            result=run([sys.executable,'-u',str(ROOT/'trial_paper.py')],timeout=12*60,check=False)
            print(json.dumps({'event':'TRIAL_POLL_END','cycle':n,'returncode':result.returncode}),flush=True)
        except subprocess.TimeoutExpired:
            print(json.dumps({'event':'TRIAL_POLL_TIMEOUT','cycle':n}),flush=True)
        # Keep cadence inside the active runner; no cron between these polls.
        end=clock();delay=next_delay(start,end)
        if end-began>=DURATION:break
        delay=min(delay,DURATION-(end-began))
        print(json.dumps({'event':'TRIAL_NEXT_POLL','after_seconds':delay}),flush=True)
        sleep(delay)
    print(json.dumps({'event':'TRIAL_SESSION_END','cycles':n}),flush=True)


def handoff():
    if not market_window(time.time()):
        print(json.dumps({'event':'TRIAL_HANDOFF_SKIPPED','reason':'OUTSIDE_SESSION'}));return
    repo=os.environ.get('GITHUB_REPOSITORY','');token=os.environ.get('GH_TOKEN','')
    if repo!='baykatemizlik-dotcom/ai-evi' or not token:raise RuntimeError('HANDOFF_CONFIGURATION_MISSING')
    url='https://api.github.com/repos/'+repo+'/actions/workflows/bist_trials.yml/dispatches'
    req=urllib.request.Request(url,data=b'{"ref":"main"}',headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},method='POST')
    # Do not expose credentials or API response bodies; no credential redirects.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    try:
        with urllib.request.build_opener(NoRedirect).open(req,timeout=20) as response:
            if response.status not in (200,201,204):raise RuntimeError('HANDOFF_REJECTED')
            print(json.dumps({'event':'TRIAL_HANDOFF_ACCEPTED','http':response.status}),flush=True)
    except urllib.error.HTTPError as e:
        status=e.code;e.close();raise RuntimeError('HANDOFF_HTTP_'+str(status)) from None


if __name__=='__main__':
    if '--handoff' in sys.argv:handoff()
    else:run_session()
