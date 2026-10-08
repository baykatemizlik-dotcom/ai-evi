# AI Evi v0.4 | GitHub Pages + Cloudflare Worker

Tek kullanıcı için ChatGPT + Gemini ortak görüşme deneme sürümü.

## Dosyalar
- `index.html`: Telefon uyumlu GitHub Pages arayüzü (demo modu dahil).
- `worker/index.js`: Cloudflare Worker API köprüsü.

## Kurulum
1. Cloudflare Workers'da yeni Worker oluştur. `worker/index.js` kodunu ekle.
2. Worker Secrets: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ACCESS_TOKEN` (uzun, rastgele erişim parolası).
3. Worker ENV: `OPENAI_MODEL=gpt-5.4`, `GEMINI_MODEL=gemini-3.8-flash` ve `ALLOWED_ORIGIN=https://baykatemizlik-dotcom.github.io`. Model adları KODDA SABİT DEĞİLDİR. Erişimi model sağlayıcısında doğrula.
4. GitHub deposunda Settings > Pages'de main branch / root kaynağını ayarla. Private repoda Pages kullanılabilirliği hesap planına bağlı olabilir. Gerekirse public yapmadan önce depoda secret bulunmadığını doğrula.
5. Pages sayfasında Ayarlar'a Worker URL ve ACCESS_TOKEN gir. ACCESS_TOKEN sadece sayfa belleğinde kalır; API secretları tarayıcıya asla yazılmaz.
6. Önce Demo, sonra /test, ardından gerçek küçük bir görevle dene.

## Güvenlik ve kısıtlar
- API anahtarları yalnız Cloudflare Secrets'ta. Bu repoya gerçek secret, şifre veya kişisel müşteri kaydı koyma.
- `/test` model listesi endpoint'lerini yoklar. Seçili modelin çalışacağını, OpenAI krediyi veya Gemini ücretsiz kotasını kanıtlamaz.
- **Gemini API'nin ücretsiz olması Worker tarafından garanti edilemez.** Google AI Studio projesinin free tier olduğunu bizzat kontrol et. Ücretli Gemini faturalandırmayı etkinleştirme.
- Otomatik mini/ücretli fallback yok. 429/403/404 halinde hata veya bekleme gösterilir.
- Bu MVP'de atomik bütçe kilidi, tekrar gönderim idempotency ve sunucu tarafı kalıcı geçmiş yoktur. Geniş kullanımdan önce eklenmeli. Yeniden denemek ek OpenAI maliyeti doğurabilir.
- Kritik borsa işlemleri, otel fiyat/iade değişiklikleri ve canlı dağıtımlar bu arayüz tarafından icra edilmez.
- `ALLOWED_ORIGIN` CORS için; tek başına kimlik doğrulama değildir. `ACCESS_TOKEN` gizli tutulmalıdır.
- İki model birbirinin görüşünü otomatik çok tur tartışmıyor. OpenAI cevap veriyor, Gemini bunu inceliyor; onay varsa REVIEWED, yoksa DISAGREE, kritik konuda NEEDS_BERKER.
- **Henüz Cloudflare deploy / canlı model çağrısı yapılmadı.**

Ortak geliştirme: ChatGPT 🤝 Gemini 🤝 Berker.
