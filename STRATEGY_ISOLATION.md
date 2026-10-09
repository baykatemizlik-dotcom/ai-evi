# BIST AVCI — SCALP / TREND V2 teslimi

Temel sürüm: `082ec96bb1f34ff87d1d5517e786bd1560acbe4c`. Bu paket çalışan iki ayrı motor, D1 migration, deterministik Worker derlemesi ve PWA içerir. **Canlı Worker/D1'e uygulanmamıştır.** Tüm icralar sanaldır.

## Dosyalar

| Dosya | Görevi |
|---|---|
| `migrations/0017_strategy_isolation.sql` | Ayrı kuyruklar, fiyatlar, Trend mumları, berker3, atomik kısmi satış defteri ve D1 koruma tetikleri |
| `worker/strategy_engines.mjs` | Scalp / Trend kuralları, slot atama, maliyet hesabı, kuyruk doldurma, manuel kapanış, portföy raporu |
| `worker/cloud_bridge.mjs` | Mevcut 15m ve çift AI Scalp onay hattının V2'ye bağlantısı; eski Sniper çalışma yolu kaldırıldı |
| `worker/dashboard.html` | İki oda, bağımsız nakit/slot özetleri, sayaç, TP1/stop, yedek listeler, filtreli satış geçmişi, PWA bildirim ayarları |
| `worker/app_shell.mjs` | Kimlik doğrulama ve HTTP rotaları; yalnız derleme şablonudur |
| `worker/index.js` | Cloudflare'a yüklenen tek dosyalık derlenmiş Worker |
| `build_worker.py` | Modülleri ve paneli deterministik olarak birleştirir; proje dışındaki dosyalara bağımlı değildir |
| `bridge/bist_sync.py` | Fiyatı bar kapanışından ayrı, sağlayıcı zamanıyla aktarır; çift AI onayından sonra tek sembol fiyatını hemen yeniler |
| `bridge/bist_trend.py` | Bağımsız 60m ve günlük veri taraması; en az 200 mum, berker3 önceliği |
| `bridge/bist_monitor.py` | Açık pozisyonları / ilgili stratejinin kuyruğunu takip eder; Trend için ayrıca 60m / günlük veri alır |
| `.github/workflows/bist_trend.yml` | Bağımsız 8 parçalı Trend taraması |
| `.github/workflows/bist_isolation_check.yml` | Dış API veya canlı DB yazısı olmadan test / derleme kontrolü |
| `tests/strategy_engines.test.mjs` | Gerçek SQLite ile iki motor ve icra muhasebesi testleri |
| `tests/test_strategy_migration.py` | Eski açık işlem ve kasa koruma testi |
| `tests/test_bist_trend.py` | Sağlayıcı saati, kapanmış 60m / günlük bar, EMA200 geçmişi testleri |

## Sermaye ve izolasyon

SCALP ve SWING D1 strateji kodları korunur; kullanıcı arayüzünde SWING, TREND olarak görünür. Her kasa başlangıçta 2.500 TL, her motor iki bağımsız slot ve slot başına **ücret ve kayma dahil en fazla 1.250 TL** kullanır. Kâr/zarardan sonra kullanılabilir nakit doğal olarak değişir; zararlar 5.000 TL'ye sıfırlanmaz. Aynı hisse iki farklı stratejide bulunabilir; aynı stratejide ikinci kez açılamaz. Her satış yalnız o stratejinin kasasına nakit iade eder.

Miktar tam lota aşağı yuvarlanır. Trend minimum 2 lot ister. TP1, başlangıç lotunun `floor(lot/2)` kadarını satar. Çift lotta tam %50; tek lotta kalan pay biraz %50'den büyük olur. 11 lot için 5 satış / 6 kalan.

## SCALP

15m teknik kuralları ve mevcut iki AI onayı korunur: RVOL >= 2, gövde >= %60, yeşil mum, üst fitil <= %20, 20 bar kırılımı, VWAP ve resmi tedbir uygunluğu. Onay sonrası **N+1 bar şartı yoktur**. Hazır fiyat varsa aynı onay akışında; yoksa tek sembol fiyat yenilemesinde alınır. İşlem saati icra anıdır, önceki barın açılışına geri yazılmaz.

`scalp_sniper_queue` süresi ilk onaydan itibaren 15 dakikadır. Tekrar istekleri süreyi uzatmaz. Kırılım/VWAP kaybedilirse aday iptal olur. Slot boşalınca hazır adaylar puan sırasıyla değerlendirilir.

Net +%3 TP / net −%1,5 SL maliyet, giriş/çıkış komisyonu ve kaymayı içerir. Bar içinde hem stop hem TP varsa stop önceliklidir. Girişten önce oluşmuş aynı barın high/low'u kullanılmaz. 60 dakika sonrasındaki bir TP, geçmiş TIME_EXIT'in yerini alamaz. 17:40 giriş kapanır; açık Scalp en son taze sağlayıcı fiyatıyla nakde çevrilir. Veri yoksa satış fiyatı uydurulmaz; yeni fiyat geldiğinde tekrar denenir.

## TREND

60m ve günlük mumlar bağımsız `trend_bars` tablosunda saklanır; bugünün tamamlanmamış günlük mumu kullanılmaz. Her iki periyotta kapanış EMA200 üstünde ve SüperTrend yeşil olmalıdır; 60m kapanış ayrıca 15m seans verisinden hesaplanan VWAP üstünde olmalıdır. SüperTrend varsayımı **Wilder ATR(10), çarpan 3**. Trend onayı bu sayısal kurallarla verilir, Scalp'ın RVOL/AI adayları otomatik Trend'e taşınmaz.

İlk stop 60m SüperTrend seviyesidir. Kullanıcının ayrı bir ilk-stop yüzdesi belirtmediği bu seçim, Scalp stopunu Trend'e kopyalamaz. `berker3_symbols` BORLS, REEDR, BINHO, ASTOR ile başlar; bunlar verilen örneklerdir, bütün liste olduğu varsayılmaz. PWA'dan liste değiştirilebilir. Öncelik, kuralları sağlayan **hazır adaylar** arasındadır; yasak/bayat/yetersiz geçmişi olan hisse zorla alınmaz. Kuyruk aynı gün 18:05 TRT'de biter, yeni Trend girişleri 18:00'dan itibaren kapalıdır.

Net +%4'e ulaşınca TP1 yalnız bir kez uygulanır. Ücret ve kaymayı da karşılayan net maliyet-koruma seviyesi `giriş_birim_maliyeti / (0.998 × 0.998)` olur. Çıplak giriş fiyatı net sıfır zarar sağlamaz. Sonraki kapanmış 60m mumlarda son iki low'un minimumu stopu yükseltir; stop düşmez, yeni stop aynı mumun geçmiş low'una uygulanmaz. Stop boşluğunda daha kötü açılış/fiyat kullanılır; maliyet koruması boşluk riskini ortadan kaldırmaz.

Pozisyon seans sonunda satılmaz. İki gün zorunlu minimum bekleme yoktur; stop daha erken çalışabilir. En fazla 5 **tamamlanmış işlem seansı** verideki günlük mumlarla sayılır; hafta sonu/işlem olmayan günler otomatik gün sayılmaz. Beş seans sonrası ilk taze fiyatla kalan lot kapanır.

## Fiyat / otomasyon sınırları

Yahoo verisi gösterge niteliğindedir; canlı piyasa verisi doğrulanmış değildir. Sağlayıcının `regularMarketPrice` ve `regularMarketTime` alanları bar close'undan ayrı alınır. Bu pakette aynı seans içinde en fazla **15 dakika yaşındaki** fiyat kabul edilir; daha eski, gelecekteki veya zaman damgasız fiyatla işlem açılmaz. Bu, gecikmeli beslemede anlık broker icrası iddiası değildir.

Kuyruk doldurma satış işlemi sonrası aynı sunucu akışında çalışır. Yeni piyasa olayının görülmesi veri beslemesine bağlıdır: mevcut hedef izleme dakikalık polling yapar, Worker cron'u dakikada bir tetiklenir; GitHub zamanlamasında gecikme olabilir. Milisaniye garantisi için sürekli gerçek zamanlı besleme/olay aktarımı gerekir. Trend tam taraması her yarım saatte, 60m/günlük kapalı verilerle yapılır.

## Muhasebe ve eşzamanlılık

`virtual_trades.lot_count` ve başlangıç komisyonu değişmez; kalan miktar `remaining_lots` ile tutulur. `strategy_exit_legs` her satışın lot/fiyat/komisyon/net PnL'sini kaydeder. UNIQUE event key + mevcut kalan lot/TP1 durumu koşulları tekrar gönderimde ikinci satış/nakit iadesini önler. Tek SQL INSERT içindeki D1 tetikleri satış defteri, kasa, kalan lot ve kapanışı tek işlemde günceller. D1 giriş tetikleri stratejiye göre nakit/tavan/slot/sinyal/fiyat/risk kontrolü yapar. Kısmi satış slotu boşaltmaz.

Gerçekleşen toplam PnL kısmi satışları da içerir; kapalı V2 pozisyon toplamını ayrıca ekleyip iki kere saymaz. Eski kapalı V1 işlemleri tarihçeye korunarak dahil edilir. Net varlık tahmini = iki kasanın nakdi + kalan lotların son mevcut fiyatla komisyon/kayma düşülmüş değeri. Bayat fiyat açıkça etiketlenir.

Yeni AL sinyali slot dolu olsa da bildirilir. Her sanal alım, TP1 ve nihai satış ayrı Web Push olayı üretir. PWA aboneliği/telefon izni gerekir; sağlayıcı kabulü telefonda görüntülenme kanıtı değildir.

## Geçiş / kurulum

1. Mevcut D1 yedeğini al; kaynak HEAD'i ve açık pozisyonları kaydet. Aktif besleme işlerini geçiş süresince duraklat.
2. Migration 0017'yi **yalnız bir kez**, 0016 sonrası uygula. ALTER COLUMN adımları yeniden çalıştırılmaz. Mevcut açık pozisyonlar V2'ye taşınır; miktar/fiyat/nakit korunur. Eski, uzun ömürlü adaylar yeni 15 dakikalık kuyruklara taşınmaz; taze onay beklenir. Eski açık SWING varsa başlangıç stopu geçişte girişin %98'i olarak korunur; böyle bir işlem ayrıca kontrol edilmelidir.
3. `python3 build_worker.py`; mevcut bindings / cron / VAPID / ACCESS_TOKEN / OPENAI / GEMINI secrets korunarak `worker/index.js` dağıt.
4. Beslemeyi V2 Python dosyalarıyla yeniden aç; Trend workflow'unu etkinleştir. API `/bist/overview` engine_version=2, kasalar ve açık miktarların değişmediğini doğrula. Bildirim/test ve manuel kapatmayı sanal ortamda kontrol et.
5. Eski Worker sürümüne tek başına geri dönme: trigger/kolon mimarisi birlikte değişir. Gerçek satış sonrası eski DB yedeğini geri yüklemek işlemleri kaybettirebilir; ilerleyen düzeltme migration'ı tercih et.

API: ingest-token korumalı `POST /bist/feed/trend`, `POST /bist/feed/quote`, `GET /bist/feed/trend-universe`; mevcut ingest/monitor/finalize korunur. Panel oturumu korumalı `GET /bist/overview`, `POST /bist/strategy/close` (`trade_id`, `strategy`), `GET|POST /bist/strategy/berker3` (`symbols`). İcra fiyatını tarayıcı göndermez; sunucu kendi kayıtlı fiyatını kullanır.

## Test

```
python3 -m pip install -r bridge/requirements.txt
python3 build_worker.py
# Node 24; yalnız geliştirme/test bağımlılıkları
npm ci --prefix tests/ui --ignore-scripts
node --test tests/ui/dashboard.test.cjs
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

Gerçek SQLite, sahte AI/ağ yanıtları ve yerel PWA fixture ile test edilir; canlı D1'e test işlemi yazılmaz. Test verilerindeki hisseler ve sonuçlar piyasa performansını göstermez. Gerçek sağlayıcıyla Trend geçmişi ve telefonda uçtan uca push testi canlı geçiş kontrolünde yapılmalıdır.

Panel DOM testi iki odanın ayrılmasını, TP1 rozetini, sayaçları, filtreleri, HTML metin güvenliğini ve sunucu fiyatlı manuel kapanışı doğrular. Gerçek iPhone görsel / push kontrolü bu testin kapsamı dışındadır.
