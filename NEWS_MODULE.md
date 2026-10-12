# Haber Modülü v1 — Kurulum ve doğrulama sınırları

## Kurulan parçalar

worker/news.mjs, worker/news-catalog.mjs, worker/news-panel.mjs; migrations/20261013_news.sql; bridge/news_sync.py.

Haber tablolari news_ önekiyle mevcut D1 içinde izoledir. Kasa, fiyat, emir ve Matriks defteri değiştirilmez. UTC zamanlar, kaynak hata durumları, RAW/READY/ACKED aktarım, SHA256 gövde ve paket doğrulaması, tekrar kontrolü, düzeltme sürümleri ve atomik ACK uygulanmıştır. Kaynak başlıkları ve küçük kimlik geçmişi ACK sonrasında kalır; gövde yalnız eşleşen ACK ile silinir. Yerel SQLite FULL synchronous ile ayrı news_archive.sqlite dosyasına yazar.

## İlk sürüm kaynakları ve eksikler

Doğrulanmış resmî RSS: TRT Haber ekonomi ve dünya. RSS son kayıt penceresidir; eksiksiz tarih arşivi değildir. PARTIAL_RSS_WINDOW gösterilir ve tam kapsama checkpoint'i ilerletilmez. Son üç günlük erişilebilir kayıtlar tekrar ayıklanarak alınır. KAP resmî veri servisinin erişimi/yanıt şeması henüz doğrulanmadı; KAP=NOT_CONFIGURED açıkça gösterilir. VBTS ayrıştırıcısı ve resmî tedbir doğrulaması bu sürümde yoktur. Tam KAP/VBTS taraması yapıldığı iddia edilmez.

Gemini kaynak analizi mevcut GEMINI_API_KEY ve GEMINI_MODEL ile yapılır; otomatik model veya ücretli plan değişimi yoktur. NEWS_AI_ENABLED=false ilk güvenlik varsayılanıdır. Paneldeki TEST yalnız açık kullanıcı isteğiyle en fazla 20 ham kayıt üzerinde analiz yapar; dalgalarda otomatik analiz açılmadan önce gerçek sonuç incelenmelidir. En fazla iki model çağrısı/dalga, uyarlanabilir 25 kayıt/42.000 karakter grupları; 50 eski RAW kayıt/dalga sınırı vardır. Ek kayıtlar silinmez. 429 veya hatalarda kontrolsüz tekrar/fallback yoktur.

Derin Google araması etkinleştirilmemiştir. Gereken kayıtlar news_followups içinde WAITING_RESEARCH kalır. Kaynak çeşitliliği ve referans setli A/B karşılaştırma henüz yapılmadı. search_queries=0 yalnız bu sürümde arama aracı kullanılmadığını belirtir; maliyet UNMEASURED ve tokenlar sağlayıcı yanıtından gelir.

## Panel

https://ai-evi.baykatemizlik.workers.dev/bist/news-panel

Önce mevcut ana panelden giriş yapılır. Durumu yenile / Haberleri topla / En fazla 20 kaydı Gemini ile test et düğmeleri vardır. POST işlemleri mevcut oturum/Bearer doğrulamasına ve Origin kontrolüne tabidir. Manuel görevler beş dakikalık aralıkta mükerrer başlatılmaz. İlk sürümde çöken bir RUNNING iş otomatik yeniden yürütülmez; görünür durum incelenmelidir.

## PC kurulumu

Bu işlem kullanıcının Windows PC'sinde yapılmalıdır; bulut yayını PC'ye dosya yüklemez.

1. bridge/news_sync.py dosyasını ayrı bir Haber_Modulu klasörüne indir.
2. O klasörde terminal aç ve `python news_sync.py --watch` çalıştır.
3. İstendiğinde mevcut panel ACCESS_TOKEN değerini gir. Token komut satırına veya dosyaya yazılmaz.
4. Ayrı news_archive.sqlite oluşturulur. Hazır kayıtlar indirilir, paket hash'i doğrulanır, yerel işlem commit olur, sonra ACK gider.

PC kapalıyken bulut toplama sürer; otomatik analiz yalnız doğrulama sonrası etkinleştirilirse çalışır. Otomatik Windows başlangıç kaydı henüz kurulmadı. Bu script haberleri arşivler; Python işlem motoruna risk bayrağı bağlanmamıştır.

## Saatler

Cloudflare cron UTC: 30 16 * * * / 30 20 * * * / 15 6 * * *; TRT 19:30 / 23:30 / 09:15. Mevcut işlem cron'u korunur. Yeni hafta sonu/gece tetiklemeleri eski işlem zamanlayıcısını çalıştırmaz. Cron propagation gecikmesi mümkündür; ilk gerçek dalga kaydı status endpoint'inden doğrulanmalıdır.

## Testler

`node --test tests/news.test.mjs` (Node 24 / node:sqlite), `python tests/test_news_sync.py`.

RSS güvenliği, gelecekteki tarih reddi, mükerrerlik, kaynak hataları, şema/kanıt/sembol doğrulaması, tam paket hash'i, ACK idempotency, PC commit-before-ACK ve yerel batch rollback testleri vardır. Mock testler gerçek Gemini analizi veya eksiksiz haber kapsamı kanıtı değildir.
