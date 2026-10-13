"""Read-only UDP connection test. No motor, database, AI calls, or orders."""
import socket,time
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
try:s.bind(('127.0.0.1',5555))
except OSError:raise SystemExit('5555 portu kullaniliyor. Diger UDP testini veya IDEAL_BASLAT penceresini kapat.')
s.settimeout(5)
print('iDeal TEST dinleniyor: 127.0.0.1:5555 | Islem/emir yok. Ctrl+C ile kapat.',flush=True)
count=0;last_print=0
try:
 while True:
  try:data,peer=s.recvfrom(60001)
  except socket.timeout:
   print('Son 5 saniyede paket yok. iDeal gonderici formulu/port ayarini kontrol et.',flush=True);continue
  count+=1;now=time.monotonic()
  if now-last_print>=2:
   print('Paket:',count,'Boyut:',len(data),'Kaynak:',peer,flush=True)
   print('Gelen Veri:',data.decode('utf-8',errors='replace').splitlines()[:3],flush=True);last_print=now
except KeyboardInterrupt:print('Test kapandi. Artik IDEAL_BASLAT 5555 portunu kullanabilir.')
finally:s.close()
