# AI Evi v0.5 | Deneysel geliştirme (CANLI DEĞİL)

Bu klasör `dev/v0.5-budget-state-machine` dalındadır. Production Worker hâlâ `worker/index.js` ile v0.4 çalıştırır. **Canlıya dağıtma onayı yok.**

## Amaç
Tek Başlat => 4 bağımsız adım:
1. GPT_DRAFT (GPT ilk öneri)
2. GEMINI_REVIEW (Gemini eleştiri)
3. GPT_REVISION (GPT eleştiriye yanıt)
4. GEMINI_FINAL (Gemini son denetim)

Her adımın yanıtı D1 veritabanına kaydedilir. `/v05/start`, `/v05/step`, `/v05/status` kullanılır. İstemci bir aşama bitince `/step` ile devam eder. Gemini geçici 503 / 429 ile hata verirse WAITING durumuna geçer ve yalnız Gemini yeniden çağrılabilir. OpenAI çıktıları tekrar üretilmez.

## Bütçe kilidi ve sınırlamalar
- Berker'in v0.5 **toplam 2 USD OpenAI test sınırı** vardır.
- `test_budget` tablosunda 200 sent kalıcı üst sınır; her GPT adımı için hata halinde bile iade edilmeyen **25 sent muhafazakâr rezervasyon**.
- Rezervasyon, tek bir koşullu `UPDATE ... RETURNING` ile veritabanı düzeyinde atomik yapılır.
- 8 OpenAI adımından sonra ek çağrı engellenir. İki OpenAI adımı/görüşme olduğundan en fazla 4 tam görüşme başlangıcı mümkün olur.
- 25 sent rezervasyon, gerçek token faturası **değildir** ve kullanım ücretiyle mutabakat yapmaz. Bu yalnızca tasarım safhası güvenlik payıdır. Modelin güncel fiyatı, maksimum token limiti ve giriş uzunluğu canlı teste geçmeden ayrıca doğrulanmalıdır. Bu kontrol katı muhasebe veya hesap genelinde mutlak fatura tavanı değildir.
- Worker'da D1 `DB` binding, model/secret ENV yoksa **fail-closed**: hiçbir ücretli çağrı yapılmaz.
- Belirsiz OpenAI isteği hata dönerse `NEEDS_MANUAL_REVIEW`: otomatik tekrar yok; iki kez ücretlendirme riskini azaltır. Tam exactly-once garantisi için iş kuyruğu, maliyet uzlaşması ve crash recovery geliştirmesi gerekir.
- Gemini ücretsiz kullanım garantisi bu kodla sağlanamaz; Google projesinin ücretli planı etkinse fatura oluşabilir. **Ücretsiz katman ve model erişimi ayrıca doğrulanmadan Gemini ücretli test yapılmamalıdır.**
- `RUNNING` kalan görevler manuel inceleme ister; otomatik kurtarma hâlâ eksik. Veritabanındaki idempotency ve yarış koşulları ayrıca test edilmeli.
- Kritik emir/iade/canlı dağıtım otomatik yapılmaz; görüşmenin final etiketi `NEEDS_BERKER` olur.
- Bu aşamada her turun sonucu ayrı ve kaydedilir, fakat zengin canlı akış otomatik çalıştırma henüz tamamlanmadı. Test UI'sinde aşama başına `Sonraki aşamaya devam` var.

## Yayından önce
1. Ayrı bir D1 test veritabanı oluşturup `schema.sql` çalıştır.
2. Özel bir test Worker'da `DB` binding'i ayarla, mevcut v0.4 production Worker'ını değiştirme.
3. D1 atomik rezervasyon, CORS/auth, 429/503, çakışan iki istek, arıza sonrası WAITING ve NEEDS_MANUAL_REVIEW senaryolarını ücretli API çağrısı olmadan sahte servislerle test et.
4. OpenAI/Gemini resmi model/ücret/istek şemalarını ve free-tier erişimini teyit et.
5. Gemini kod denetimi ve Berker'in ayrı canlı dağıtım onayı olmadan yayımlama.

Gizli anahtarları GitHub'a veya bu belgeye ekleme.
