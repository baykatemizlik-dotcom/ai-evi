iDeal -> AI Evi yerel motor (13 Ekim 2026)

KURULUM
1. Mevcut BASLAT penceresini ve eski UDP dinleyicisini kapat.
2. Bu ZIP icindeki dosyalari mevcut BASLAT.bat/runtime.mjs/engines.mjs bulunan
   klasore kopyala. Yeni ayri motor klasoru acma.
3. IDEAL_KUR.bat dosyasini calistir. Uyum kontrolu ve yedek otomatik.
4. IDEAL_BASLAT.bat dosyasini calistir. Eski BASLAT yerine bunu kullan.
5. iDeal ALGO'da IDEAL_KOPRU.cs icerigini formul govdesi olarak ekle ve etkinlestir.
   Eski 3 alanli gondericiyi durdur; iki farkli gonderici birlikte kullanma.
6. http://127.0.0.1:9001/ideal-status: received/accepted artmali; rejected ve
   last_error kontrol edilmeli. /status fiyatlar ve bar adetlerini gosterir.
   /engine motor/haber/Mini/bulut sonucunu gosterir. cloud_snapshot_error bos,
   cloud_snapshot_last_success_at yeni olmali.

Fiyat alici 127.0.0.1:5555'te yalnizca yerel UDP dinler. Telefon UDP'ye
baglanmaz; mevcut PC -> Cloudflare -> telefon ozet akisi devam eder.
Matriks aboneligi/uygulamasi gerekmez. Mevcut engine.sqlite/news archive ve
connection.json tokenlari korunur. connection.json'da gecikme 0 ve kaynak
IDEAL_UDP olur. Kurulum eski kod/ayar dosyalarini ve SQLite yedegini ideal_backup_* icine koyar.
Motor ilk acilista strategy_quotes kaynak CHECK kisitina IDEAL_LIVE ekler;
kayitlar, indeksler ve koruyucu tetikleyiciler aynen korunur.
Haber gardiyani, Gemini ve Mini yamasinin kurulmus olmasi gerekir.

ESKI AKIS / YENI AKIS
THYAO;287,25;1000000 kabul edilir, ancak kaynak saati ve birimler bilinmedigi
icin sadece yerel veri testinde/radarda gorulur. Emir, cikis veya mum uretmez.
Q;THYAO;287.25;turnover_TL;UTC_poll_time;lot_day;limit_up;prev_close;sequence
B;THYAO;15m;UTC_start;UTC_end;open;high;low;close;lot_volume;LOT
B sadece iDeal kapanmis grafik verilerinden aktarilir. Fiyat orneklerinden
OHLC veya hacim uydurulmaz. Gunluk TL hacmi lot hacmi yerine kullanilmaz.

DOGRULAMA VE SINIRLAR
Python UDP ve mevcut motor baglantisi kontrollu yerel paketlerle test edildi.
iDeal C# formulu sizin iDeal surumunuzde henuz derlenip calistirilmis degildir.
Grafik Date alaninin Istanbul saati, Size alaninin lot miktari oldugunu paketinizde
kontrol edin; degilse veri birimi duzeltilmeden motoru kullanmayin.
Q saatleri kaynak yoklama saatidir, borsa islem saati degildir. Kopru calisirken
veri lisansi/terminalin piyasa baglantisini ayrica kontrol edin. Canlilik/gun/saat
kontrolleri terminalin lisans durumunu tek basina kanitlamaz.
UDP teslim garantisi vermez. Gunluk turda mumlar tekrar gonderilir; fiyatlarda
sembol bazinda son paket kazanir, sira gerilemesi elenir. Yeniden gonderilmeyen
mumlar motorun mevcut yeterlilik kontrollerine takilabilir.
Fiyatlar hemen gorunur; 631 sembolun 15m mumlarini ilk tur yuklemek yaklasik
7 dakika + iDeal okuma suresi alabilir. Tek hisse/periyot tarihce okunur,
grafik acilmaz; iDeal'in kendi tarihce RAM tuketimi ayrica olculmelidir.
Eski deneme V4PT/V4QQ motorlari bu baslat ile calistirilmaz; Scalp/Trend mevcut
haber/Mini akisiyla calisir. Deneme kasalari degismez.
Mevcut strateji 15 dakikalik kapanmis mum kullanir. 1 dakikalik yeni scalp veya
tavan kilidi stratejisi eklenmedi. Resmi tavan fiyati Q paketinde tasinir.

Bu SANAL motor baglantisidir. Canli fiyat almak, araci kuruma emir gonderme
baglantisi degildir. Gercek alim/satim API'si bu paketle etkinlesmez.

GERI DONUS
IDEAL_BASLAT'i kapat; ideal_backup_* icindeki dosyalari ayni motor klasorune
 geri kopyala. Veritabanlarini veya WAL/SHM dosyalarini silme.

Resmi fonksiyon belgeleri:
https://idealdata.com.tr/yuzeyselveri-fonksiyonu/
https://en.idealdata.com.tr/grafik-verilerini-oku/
