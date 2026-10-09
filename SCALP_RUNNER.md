# Scalp Runner — sanal işlem

Bu güncelleme dual-engine taslak dalını genişletir. Production'a yayınlanmamış ve D1 migrasyonu uygulanmamıştır.

## Dosyalar
- `worker/strategy_engines.mjs`: Scalp TP1/Runner, kısmi satış muhasebesi ve panel API alanları. Trend motorunun fonksiyonları değişmez.
- `migrations/0018_scalp_runner.sql`: 0017 ardından bir kez uygulanır. Nakitleri, mevcut lotları, Trend stop/durumunu ve geçmişi sıfırlamaz.
- `worker/dashboard.html`: Scalp açık işlem ve yedek sinyal kartları, üç fiyat kopyalama butonu, Runner sayacı, satış nedenleri.
- `worker/index.js`: `python build_worker.py` ile üretilen dağıtım dosyası.
- `tests/strategy_engines.test.mjs`, `tests/test_strategy_migration.py`, `tests/ui/dashboard.test.cjs`: muhasebe, zamanlama, izolasyon ve kart doğrulamaları.

## Durum akışı
1. Başlangıç lotu gerçek 1.250 TL slot bütçesinden tam lot hesaplanır; 100 birim yüzde örneğidir.
2. TP1 öncesinde net -%1,5 stop bütün lotları kapatır; mevcut 60 dakika TIME_EXIT korunur.
3. Net +%3 TP1: `floor(original_lots * 0.7)` satılır. 100 lotta 70/30; 11 lotta 7/4. Yeni Scalp girişleri en az 2 lot gerektirir. Önceden açık 1 lotlu işlem bölünemediğinden eski tam TP çıkışıyla kapatılır.
4. TP1 sonrası Runner'da TIME_EXIT yoktur. Kalan lotlar net maliyet stopu ya da 17:40 Europe/Istanbul çıkışına kadar taşınır. +%9,90 ayrı bir erken satış tetikleyicisi değildir; tavan önceki kapanışa göre belirlenir, giriş fiyatına göre varsayılmaz.
5. TP1 satış geliri yalnız Scalp nakdine aktarılır. Slot kalan lotlar bitene kadar doludur. Tam kapanışta Scalp yedek kuyruğu değerlendirilir. Trend nakdi ve kuyruğu etkilenmez.

## Fiyatlar
Motor mevcut %0,2 satış kayması ve %0,2 komisyon modelini korur. Birim maliyet `executed_price + entry_commission / original_lots`; net TP1 eşiği `unit * 1.03 / (0.998 * 0.998)` ve net maliyet stopu `unit / (0.998 * 0.998)` olur. Böylece BE fiyatından satışın tahmini kalan-lot net PnL'si sıfırdır; aşağı fiyat boşluğunda sıfır garanti edilmez.

Emir Kurulum Kartı kullanıcı isteğine göre brüt `executed_price * .985`, `executed_price * 1.03` ve giriş fiyatını gösterir. Bu QNB emir girişi için kopyalanabilir taslaktır; QNB uygulamasına emir göndermez. Brüt giriş fiyatı stopu masraflar sonrası net sıfır değildir. QNB fiyat adımları, OCO/iptal-değiştirme ve zincir emir otomasyonu doğrulanmış değildir. Fiyatlar dört ondalığa kadar virgülle kopyalanır; uygulamanın kabul ettiği fiyat adımı kontrol edilmelidir.

## Kronoloji ve atomiklik
- Aynı OHLC mumunda başlangıç stopu ve TP1 görülürse muhafazakâr biçimde stop önce gelir.
- TP1 barının kapanışı Runner aktivasyonudur. Aynı mumun önceden oluşmuş dibine yeni BE stopu uygulanmaz.
- Quote kaynaklı TP1'de quote zamanı aktivasyondur; o zamanı kapsayan tamamlanmış mum geriye dönük kullanılmaz.
- Kısmi satış ve final satış farklı idempotency anahtarlarıyla, D1 trigger'larında nakit, lot ve durum güncellenerek işlenir. Aynı gözlemin tekrarı iki kez satış yapmaz.
- 17:40'tan eski quote gün sonu fiyatı gibi kullanılamaz. Uygun güncel quote/bar yoksa işlem açık kalır ve fiyat bekler. Mevcut GitHub Actions / Yahoo akışı gerçek zamanlı veri değildir; 17:40 icrası ancak ilk uygun gözlemde gerçekleşir.
- Manuel kapat kalan lotları taze sunucu quote'u ile kapatır. Her kısmi/final satış mevcut bildirim outbox'ına ayrı olay ekler; yeni push kurulumu gerekmez.

## Yayına alma
Önce 0017 (henüz uygulanmadıysa), ardından 0018 D1 migrasyonları uygulanmalı; sonrasında bu dalın üretilmiş Worker'ı yayınlanmalıdır. Migrasyon/Worker birlikte planlanmalıdır: eski Worker yeni Scalp TP1 davranışını çalıştırmaz. Canlı işlemlere veya gerçek aracı kurum hesabına bağlantı yoktur.
