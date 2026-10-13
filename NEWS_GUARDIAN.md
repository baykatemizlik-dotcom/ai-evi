# Haber gardiyanı ve teknik motor

Haber tek başına işlem üretmez. Teknik aday havuzu oluşur, aktif doğrulanmış kara liste elenir, doğrulanmış öncelikli adaylar öne alınır; mevcut fiyat, hacim, tavan marjı, kota ve diğer risk kontrolleri yine uygulanır. Öncelik daha çok para tahsis etme veya teknik eşiği gevşetme yetkisi vermez. Satış/stop/TP kuralları bu değişiklikle değiştirilmez.

## Uygulanan bağlantılar

- Bulut kaynakları: TRT ekonomi/dünya, Bloomberg HT, Foreks, Ekonomim, CNN Türk Ekonomi, Habertürk Ekonomi, TCMB Atom duyuruları, KAP toplu başlık/özet sorgusu ve BIST resmî tedbir CSV.
- RSS/CSV her 15 dakikada kontrol edilir; KAP ilk toplamada, saat başında ve 19:30/23:30/09:15 Türkiye saati dalgalarında sorgulanır. RSS kaynağın son penceresidir; evrendeki her şirketin eksiksiz haber kapsamı iddia edilmez. NTV ekonomi akışı testte eski kalmıştır ve etkinleştirilmemiştir.
- BIST tedbirleri sembol, tedbir kodu, başlangıç/bitiş tarihleri ile deterministik ayrıştırılır. Kayıtlar Gemini/mini çağrısı gerektirmeden READY olur; yerel senkron bekler. Bitiş tarihi Türkiye gününün sonuna kadar dahil edilir. Liste eskiyse kaynak zamanı ayrıca korunur; kapsam risksiz diye varsayılmaz.
- KAP hâlen başlık/özet düzeyindedir; tam bildirim ve ekler okunmaz. Resmî kaynaktan gelmek, içeriğin etkisinin tam doğrulandığı anlamına gelmez. Özetler zorunlu takip/belirsizlik taşır.
- `bridge/news_sync.py`, doğrulanmış hash ile yerel arşiv yazarken aynı SQLite işleminde `stock_intelligence` projeksiyonunu oluşturur; yalnız commit sonrası ACK gönderir.

## Etkin etiketlerin durumu

`BLACKLIST`: şu an yalnız deterministik BIST tedbir kayıtlarından otomatik oluşturulur. Kullanıcının strateji politikası, listedeki tüm tedbirleri giriş engeli sayar. Örneğin kredili işlem yasağı her türlü nakit alımın hukuken yasak olduğu anlamına gelmez; stratejinin eleme tercihidir.

`PRIORITY_RADAR`: okuyucu ve aday sıralayıcı destekler. Ancak bugünkü Gemini/mini yorumları henüz doğrulanmış öncelik etiketi üretmez; büyük sözleşme/finansal sürpriz için temel eşik, maddilik, şirket ilişkisi ve kaynak içeriği doğrulaması gerekir. Salt olumlu yorum, bedelli/bedelsiz başlığı veya yüksek importance etkin öncelik oluşturmaz.

`NEUTRAL`: diğer etkin kayıtlar veya hiç doğrulanmış aktif kayıt bulunmaması. Kayıt yoksa ayrıca `coverage_status=UNKNOWN` döner. Bu durum haber riski yok demek değildir. Teknik sistemin mevcut resmî tedbir/veri tazelik kontrolü sürdürülmelidir.

Söylenti, sektörel çıkarım ve model önerisi doğrudan BLACKLIST olmaz. Fabrika duruşu, konkordato gibi olaylar için tam ve doğrulanmış olay adaptörü henüz eklenmemiştir. Yeni nötr kayıt, eski fakat hâlen aktif BLACKLIST'i geçersiz kılmaz. Erken kaldırma/düzeltme için resmî iptal doğrulaması gerekir; sırf sonraki listede görünmüyor diye yasak silinmez.

## PC giriş noktası

PC'ye güncel `news_sync.py` ve `news_guardian.py` birlikte kurulmalıdır. Bu sohbet PC dosyalarını değiştiremez; mevcut giriş noktasına kurulum uçtan uca doğrulanmış değildir. Depodaki çalışan teknik karar yolu esas olarak Cloudflare'dadır ve kendi resmî risk kontrolüne sahiptir. Bu Python filtre API'si yerel teknik motor için hazırlanmıştır; onu çağırmadan yerel girişleri etkilediği söylenemez.

```python
import sqlite3
from news_guardian import schema, validate_entry, prioritize_candidates

news_db = sqlite3.connect("news_archive.sqlite")
schema(news_db)
news_db.commit()

# Her aday teknik motorun mevcut bütün kontrollerini önceden geçmelidir.
ranked = prioritize_candidates(technical_candidates, news_db.cursor())
for candidate in ranked:
    if not validate_entry(candidate["symbol"], candidate["technical_signal"], news_db.cursor()):
        continue
    # Mevcut fiyat/kota/sermaye kontrolleri ve mevcut giriş fonksiyonu burada çalışır.
```

## Mini ile 5–10 adayın sıralanması

Bulut SCALP bağlantısı uygulandı: tek çağrıya yalnız teknik elemeden geçen 5–10 adayın kısa metrikleri ve ilgili tarihli haber özetleri girer. Mini yalnız sağlanan sembolleri sıralar; yeni sembol/emir/pozisyon büyüklüğü üretmez. İsterse hiç aday önermeyebilir. Çıktı sunucu tarafından aday listesi, kara liste ve tazelik kurallarına karşı doğrulanır. Model PRIMARY/BACKUP/WATCH üretir; WATCH veya confidence <70 giriş onayı almaz. Bulut SCALP'ın mevcut mini onay aşamasında tek grup çağrısı kullanılır; aynı adaylar ayrıca eski tekil mini çağrısına gönderilmez. Seçim sırası mevcut SCALP kuyruğunda uygulanır, 15 dakika aday süresi ve işlem anındaki teknik/risk kontrolleri korunur. Çıktı hatası veya timeout yeni seçim yolunu duraklatır; kaynak toplama ve mevcut pozisyonların çıkış yönetimi sürer. Günlük 0,25 USD sınırı yalnız bu yeni sıralamaya aittir; mevcut Gemini veya diğer AI çağrılarına ait toplam maliyet sınırı değildir. Hata yanıtı kullanımı bildirmediyse muhafazakâr ayrılmış bütçe korunur. Panelde aç/durdur ve kullanım/ayrılmış bütçe bilgileri gösterilir. Aynı tarama/girdi için beş dakikalık dilimde tekrar istek önbellekten karşılanır. Gerçek mini aday seçim turu henüz gözlenmedi; entegrasyon testi sahte API cevabıyla çalıştırıldı.

Gemini görevleri: mevcut teknik onay aşaması korunur; haber yorumlama 19:30, 23:30, 09:15 TRT dalgalarında en fazla 20 kayıt/2 çağrı ile açılmıştır. 15 dakikalık ara haber toplamalarında model çağrısı yapılmaz. Haber Gemini çıktısı AL/SAT emri veya kesin BLACKLIST üretmez. Satışa dair yeni AI emir kuralı eklenmemiştir.

Matriks · PC görünümü kendi yerel motorunu yansıtır. Bu bulut seçim değişikliği PC motoruna otomatik kurulmaz; PC'nin giriş/aday kuyruk dosyası ve kaynak kodu bu depoda bulunmadığı için o yolun kurulumu hâlen doğrulanmamıştır.

Örnek tahmin (`gpt-4o-mini`, normal API tarifesi; web araştırması hariç): 3.000 giriş + 500 çıkış token ≈ 0,00075 USD; 10.000 giriş + 1.000 çıkış token ≈ 0,0021 USD. Gerçek hacim/çağrı sayısı ve tekrarlar ölçülmeden günlük toplam kesin söylenmez.
