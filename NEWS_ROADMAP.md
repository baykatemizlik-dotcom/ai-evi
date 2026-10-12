# Haber motoru — çalışma durumu

## Otomatik akış

Bulut her 15 dakikada TRT ekonomi/dünya, Bloomberg HT RSS ve TCMB resmî duyuru Atom akışını toplar. KAP sitesi toplu başlık/özet sorgusu ilk taramada, saat başlarında ve üç ana dalgada çalışır; 631 tekil sorgu yapılmaz. PC kapalıyken de çalışır. 19:30, 23:30 ve 09:15 Türkiye saati taramaları korunur. Haber görevleri mevcut işlem zamanlayıcısını tetiklemez. Aynı zaman dilimi ve aynı kaynak/bildirim/içerik tekrarları yeni kayıt oluşturmaz; düzeltmeler ayrı sürüm olur. Sonraki tarama saati ve hata durumu panelde görünür.

Panel açık ve görünürken 30 saniyede durum, günlük özet ve liste yenilenir. Varsayılan sıralama yayın zamanına göre yeni → eskidir; kaynak geçmiş tarihli haber verirse o tarih sırasına girer. Bu, kaynağın kesintisiz canlı akış garantisi değildir. Liste kapalı başlar ve 50'şer açılır. Arama mevcut başlık, kaynak metni ve yorum üzerinde çalışır; hisse, sektör, kaynak, etki, önem, takip, herhangi/tüm/hariç kelimeler ve tam ifade desteklenir.

## Yorumlama ve maliyet

Gemini ve GPT mini yorumları en fazla 20 kayıt ve 2 çağrıyla elle başlatılır. Otomatik ücretli yorumlama kapalıdır; mini canlı testi ve gerçek token ölçümü beklenir. Hata gelen kayıt RAW/bekliyor kalır; haber toplama bağımsız devam eder. Çıktı sayısı, semboller, kaynak bağlantıları ve şema doğrulanmadan analiz kaydedilmez. Mini kullanımı varsa token ve tahmini USD gösterilir. Model hatasından sonra otomatik başka modele geçilmez. İlerleme çubuğu tamamlanan aşamaları gösterir; yanıt beklerken sabit kalabilir.

## Kapsam

631 doğrulanmış sembol sözlüğü eşleştirme içindir, 631 şirketin tüm haberlerinin toplandığı anlamına gelmez. TRT ve Bloomberg HT son RSS penceresi, TCMB son 31 günlük duyuruları ve KAP'ta dün/bugün şirket grubuna gelen başlık/özetler alınır. Sabah görünümü dün 00:00 ile bugün 09:15 Türkiye saati aralığını gösterir; 09:15 öncesinde yalnız henüz gelmiş kayıtları kapsar. Daha eski haberler bu görünüme karışmaz. TCMB boş özet sağlıyorsa içerik yalnız başlıktır; tam duyuru okunmuş sayılmaz. KAP_PUBLIC resmî sitenin kamuya açık toplu sorgu adaptörüdür; 12 Ekim 2026 için 412 satırla yerel canlı okuma doğrulanmıştır. Tam bildirim metni/ekler okunmaz ve lisanslı üretim API'si değildir. Model için özetlerin followup/belirsizlik bayrağı zorunludur. Yanıt 1500 satırı aşarsa hata verilir; eksiksiz piyasa kapsamı iddia edilmez. KAP lisanslı API, SPK bülteni ve Borsa İstanbul/VBTS adaptörleri henüz bağlı değildir. API üretimi sözleşme, API anahtarı ve IP yetkisi ister. AA RSS denemeleri HTTP 502 döndürdü; etkin kaynak değildir. Hedefli internet araştırması henüz çalışmaz. Matriks PC haber/olay aktarımı çalışması kullanıcı isteğiyle beklemededir; panelde sıfır görünmesi kaynakta hiç haber olmadığı anlamına gelmez.

## Mevcut kayıtlar

Geçmiş ve yeni kayıtlarda şirket/sektör/küresel/genel ayrımı okunurken uygulanır. Yorumlanmamış küresel başlıklar yalnız anahtar kelime ipucudur; şirkete doğrulanmış etki sayılmaz. Yorumlanan kayıtta kaynak bilgisi, olgu, çıkarım, belirsizlik ve takip gereksinimi ayrı gösterilir. Günlük özet seçili Türkiye tarihini, üst sayaç tüm zamanları gösterir. Tarih aralığı API'de en fazla 31 gün; özet/arama en fazla 1200 kaydı inceler ve sınır aşımı açıkça bildirilir.

## Sonraki adımlar

1. Mini ile canlı küçük test: başarı, hata, token ve maliyet ölçümü.
2. Yorumlama kuyruğu: ölçüme göre günlük bütçe, kilit, tekrar deneme aralığı ve hata sonrası durdurma ile otomasyon.
3. Başlık/özet yerine tam KAP metni ve ekleri için yetkili KAP erişimi ve SPK/VBTS adaptörlerini gerçek içerik ve düzeltme testleriyle bağlama.
4. Eksik/çelişkili yüksek önem olayları için sınırlı hedefli araştırma.
5. PC SQLite aktarımını uçtan uca doğrulama. ACK yalnız doğrulanmış yerel kayıt sonrası bulut gövdesini siler; başlık ve kimlik korunur. Silinmiş analiz bulutta yeniden yorumlanmaz.
6. `/bist/news/context?symbol=THYAO` danışma çıktısını botun seçim/risk katmanına bağlama. Şimdilik doğrudan şirket, dolaylı sektör ve genel bağlam ayrılır; emir üretilmez ve mevcut seçim stratejisi bu veriyi henüz kullanmaz. Eksik veri risksiz sayılmaz.
