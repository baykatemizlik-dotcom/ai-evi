# Matriks haber/olay bağlantısı — emir göndermeyen ayrı strateji

Bulut alıcısı ve GPT mini testi hazırdır. Windows/Matriks üzerinde kurulup gerçek kayıt alınmadan bağlantı tamamlandı sayılmaz.

## PC kurulumu

1. Windows'ta `%LOCALAPPDATA%\AI_Evi` klasörünü oluştur.
2. `bridge/bist_news_symbols.txt` dosyasını bu klasöre kopyala. Mevcut 631 sembol içerir; endeks filtresi uygulanmaz. Lisans/terminal kayıt limitleri ayrıca test edilmelidir.
3. MatriksIQ AlgoTrader içinde `MatriksNewsEvents` adlı **ayrı** strateji oluştur, `bridge/MatriksNewsEvents.cs` içeriğini yapıştır ve derle. Mevcut fiyat/scalp stratejisini değiştirme. SDK'nin `OnNewsReceived(AlgoNewsModel)` desteği (5.4.1.0 ve sonrası) gerekir. Yerel SDK mevcut olmadığından burada C# derlemesi doğrulanamadı.
4. Stratejiyi canlı veri modunda çalıştır. Emir gönderme kodu yoktur. Sadece yeni bildirimler alınır; backtest/geçmişe dönük tam tarama yapılmaz.
5. `%LOCALAPPDATA%\AI_Evi\matriks_registration_status.json` içindeki istenen/kaydedilen sembol sayıları ve hataları kontrol et. Başarılı SDK kaydı bütün haberlerin lisanslı olarak teslim edildiğinin kanıtı değildir.
6. `bridge/matriks_news_upload.py` dosyasını indir ve `python matriks_news_upload.py` çalıştır. İstendiğinde mevcut panel ACCESS_TOKEN'ını gir; token dosyaya kaydedilmez. OpenAI/Gemini anahtarları PC'ye verilmez.
7. Haber/olaylar önce yerel `news_archive.sqlite` içine kalıcı yazılır, sonra buluta aktarılır. İnternet kesilirse yerel kuyruk korunur, yeniden gönderimler sunucuda tekrar kaydedilmez. JSONL dosyasını kesme/silme; yükleyici byte checkpoint kullanır.
8. Haber panelini yenile. Matriks son kayıt saati, haber sayısı ve teknik olay sayısı görünmeli. Sonra **GPT mini** düğmesiyle en fazla 20 haberlik testi başlat.

## Kapsam ve sınırlar

- Haber: belgelenen callback başlık, semboller, haber ID'si ve kaynak sağlar. Bu sürüm **başlıkla sınırlıdır**; `HasDetail` gövde alınmış demek değildir. Mini, boş gövdeli kayıtları yüksek belirsizlik ve takip gereksinimiyle işaretler. Tam metin/ek dosya alma doğrulanmadı.
- Olay: `OnFormationReceived` ve `OnDetectorReceived` kaydedilir. Olaylar haberlerden ayrı tabloya gider, AI'ya/işlem motoruna otomatik gönderilmez.
- Ekrandaki orta/uzun vadeli otomatik **trend uyarılarının** dışa aktarımı henüz doğrulanmadı. Bu kolektör onları aldığını iddia etmez.
- BIST dışındaki teknik olaylar kabul edilmez. Haberlerde tanınmayan semboller ayrıca korunur, sessizce resmi sembol kabul edilmez.
- PC/Matriks kapalıyken bu kaynak durur; TRT bulut koleksiyonu devam edebilir. Kaçırılan zaman aralığına tamlık garantisi verilmez.
- KAP sözcüğüyle kayıt olunması doğrudan KAP API'si veya tam KAP kapsamı anlamına gelmez. Kullanıcının haber paketi/lisansı belirleyicidir.
- Yerel dosya yazma başarısızlığı Matriks Debug penceresinde görünür; bu durumda bildirimin kalıcı kaydı garanti edilemez.
- Bulut teknik olay gövdeleri bu ilk sürümde tutulur; otomatik silme/yerel arşive ACK aktarımı henüz bağlanmadı.

## GPT mini ve maliyet ölçümü

Mevcut sistemin mini modeli `gpt-4o-mini`, mevcut Worker `OPENAI_API_KEY` ile yalnız elle test edilir. Otomatik ücretli analiz açılmaz; otomatik Gemini fallback yoktur. Test başına en fazla iki model çağrısı / 20 haber; kayıt sayısı karakter sınırı nedeniyle daha az olabilir. Kayıt, şema ve kimlik doğrulaması başarısız olursa kuyruk korunur.

Panel her başarılı veya çıktı doğrulaması reddedilmiş çağrıda sağlayıcının token kullanımını tutar. Tahmini USD hesabı standart metin tarifesiyle yapılır: 1M girdi 0,15 USD, önbellekli girdi 0,075 USD, çıktı 0,60 USD (resmî fiyat kontrolü: 13 Ekim 2026). Vergi, döviz ve hesap özelindeki farklar dahil değildir. HTTP hatalarında usage alınmadıysa maliyet bilinmiyor gösterilir. Kesin günlük maliyet, gerçek günlük hacim ölçülmeden söylenmez.

## Kaynaklar

- https://iqyardim.matriksdata.com/docs/matriksiq-kullanim-kilavuzu/algotrader/haberlerin-stratejide-kullanimi/
- https://iqyardim.matriksdata.com/docs/matriksiq-kullanim-kilavuzu/algotrader/formasyon-verilerinin-kullanimi/
- https://iqyardim.matriksdata.com/docs/matriksiq-kullanim-kilavuzu/algotrader/dedektor-verilerinin-kullanimi/
- https://developers.openai.com/api/docs/models/gpt-4o-mini
