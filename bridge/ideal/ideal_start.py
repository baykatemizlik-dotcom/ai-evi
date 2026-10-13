"""One managed launcher; children stopped on exit. No real broker calls."""
import subprocess,sys,time,socket,json,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parent
children=[]
lock=socket.socket()
try:
    lock.bind(('127.0.0.1',5556));lock.listen(1)
except OSError:raise SystemExit('iDeal BASLAT zaten acik. Ikinci pencere acilmayacak.')
try:
    children.append(subprocess.Popen([sys.executable,'-u',str(ROOT/'receiver.py')],cwd=ROOT))
    for i in range(60):
        if children[0].poll() is not None:raise RuntimeError('RECEIVER_STOPPED_CHECK_OUTPUT')
        try:
            with urllib.request.urlopen('http://127.0.0.1:9001/ideal-status',timeout=1) as r:
                if json.load(r).get('transport')=='IDEAL_UDP':break
        except Exception:time.sleep(.25)
    else:raise RuntimeError('IDEAL_RECEIVER_NOT_READY')
    children.append(subprocess.Popen(['node',str(ROOT/'runtime.mjs')],cwd=ROOT))
    print('iDeal motoru: http://127.0.0.1:9001/engine | UDP: 5555',flush=True)
    print('Kapatmak icin Ctrl+C. Mevcut haber/Mini baglantisi korunur.',flush=True)
    while True:
        if any(p.poll() is not None for p in children):raise RuntimeError('CORE_PROCESS_STOPPED_CHECK_OUTPUT')
        time.sleep(1)
except KeyboardInterrupt:pass
finally:
    for p in children:
        if p.poll() is None:p.terminate()
    for p in children:
        try:p.wait(timeout=5)
        except subprocess.TimeoutExpired:p.kill()
    lock.close()
