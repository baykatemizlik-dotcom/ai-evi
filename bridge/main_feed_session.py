"""Run the unchanged 8-shard 15m scanner on a five-minute bounded cadence.

Only scheduling/orchestration changes. Existing strategy, fees, capital, risk,
AI review and ingestion reducers remain untouched.
"""
import json,os,subprocess,sys,tempfile,time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from trial_session import market_window,next_delay,handoff

ROOT=Path(__file__).resolve().parent
DURATION=25*60


def scan_cycle(universe,cycle,run=subprocess.run):
    env=dict(os.environ,BIST_UNIVERSE_JSON=universe,BIST_SHARD_COUNT='8',BIST_RUN_ID=os.environ.get('GITHUB_RUN_ID','LOCAL')+'-'+os.environ.get('GITHUB_RUN_ATTEMPT','1')+'-c'+str(cycle))
    def shard(i):
        try:return run([sys.executable,'-u',str(ROOT/'bist_sync.py')],env=dict(env,BIST_SHARD_INDEX=str(i)),timeout=14*60,check=False).returncode
        except subprocess.TimeoutExpired:return 124
    with ThreadPoolExecutor(max_workers=8) as pool:codes=list(pool.map(shard,range(8)))
    # Preserve existing behavior: finalize the available pool after partial shards.
    result=run([sys.executable,'-u',str(ROOT/'bist_sync.py'),'--finalize'],env=env,timeout=35*60,check=False)
    print(json.dumps({'event':'MAIN_CYCLE_END','cycle':cycle,'shard_returncodes':codes,'finalize_returncode':result.returncode}),flush=True)
    return codes,result.returncode


def loop(universe,clock=time.time,sleep=time.sleep,scan=scan_cycle):
    began=clock();cycle=0
    while market_window(clock()) and clock()-began<DURATION:
        start=clock();cycle+=1
        print(json.dumps({'event':'MAIN_CYCLE_START','cycle':cycle,'epoch':start,'interval_seconds':300}),flush=True)
        try:scan(universe,cycle)
        except subprocess.TimeoutExpired:print(json.dumps({'event':'MAIN_CYCLE_TIMEOUT','cycle':cycle}),flush=True)
        end=clock()
        if end-began>=DURATION:break
        delay=min(next_delay(start,end),DURATION-(end-began))
        print(json.dumps({'event':'MAIN_NEXT_CYCLE','after_seconds':delay}),flush=True);sleep(delay)


def main():
    if not market_window(time.time()):print('MAIN_OUTSIDE_SESSION');return
    with tempfile.TemporaryDirectory(prefix='bist-main-session-') as directory:
        output=Path(directory)/'prepare-output'
        subprocess.run([sys.executable,'-u',str(ROOT/'bist_sync.py'),'--prepare'],env=dict(os.environ,GITHUB_OUTPUT=str(output)),timeout=6*60,check=True)
        universe=next(line[len('universe='):] for line in output.read_text().splitlines() if line.startswith('universe='))
        assert len(json.loads(universe)['symbols'])>=400
        loop(universe)


if __name__=='__main__':
    if '--handoff' in sys.argv:handoff('bist_sync.yml')
    else:main()
