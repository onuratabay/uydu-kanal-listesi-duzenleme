# TV Kanal Yöneticisi

Xiaomi TV A55 (MiTV-MZTU0, Android TV 14, MediaTek "merak") uydu kanal listesini Mac'ten ADB ile
okuyan, tarayıcıda topluca düzenleten ve sıralamayı TV'ye geri uygulayan yerel araç.

```bash
npm install
npm start            # derler ve http://localhost:4310 adresinde açar
```

Geliştirme için `npm run dev` (Vite: http://localhost:5173). TV adresi farklıysa:
`TV_SERIAL=192.168.1.35:5555 npm start`.

## Özellikler

- **Okuma ve yedek:** Kanal listesini (ad, TvProvider `_id`, numara) TV'den okur; her okuma `backups/`
  klasörüne JSON + CSV olarak kaydedilir.
- **Düzenleme:** Sürükle-bırak, çoklu seçim, arama, en üste/alta, numaraya taşı, geri al/yinele,
  otomatik sıralama (isim, HD önce, şifreli/test kanalları sona, öncelik listesi), CSV/JSON içe/dışa aktarma.
- **TV'ye uygulama:** En az taşıma sayısıyla, her adımı ekrandan doğrulayarak (tek taşımalık deneme modu).
- **Çift kanal temizliği:** Aynı kanalın kopyalarında şifresiz ve en yüksek kaliteli olan kalır, diğerleri
  LiveTV'nin "Kanalları sil" ekranından doğrulamalı otomasyonla silinir.
- **Şifreli kanallar:** Ekran taramasında kilit ikonundan tespit edilir, listede gizlenebilir.
- **TV bulma:** `TV_SERIAL` verilmezse ADB'ye bağlı Xiaomi TV otomatik seçilir (IP değişse de).

## Nasıl çalışıyor (ve neden böyle)

| İhtiyaç | Root'suz durum | Kullanılan yöntem |
|---|---|---|
| Kanal veritabanını okumak | `TvProvider` kabuk kullanıcısına satır döndürmüyor; MediaTek/LiveTV veritabanları `android.uid.system` ve izinle korunuyor | LiveTV'nin izinsiz dışa açık **sistem arama sağlayıcısı** (`com.mitv.livetv.system_search`) |
| Veritabanını yedeklemek | `adb backup` sistem uygulamalarında çalışmıyor; LiveTV'deki "USB'ye dışa aktar" bu platformda (`aow`) kodda kapalı | Okunan listenin JSON + CSV kopyası (`backups/`) |
| Sıralamayı yazmak | Doğrudan yazma yetkisi yok | TV'nin kendi **"Kanalları yeniden düzenle"** ekranı, kumanda tuşlarıyla otomasyon |

**Okuma (salt okuma, ~3,5 dk):** Arama sağlayıcısı `numara == sorgu` veya `ad sorguyu içerir` filtresiyle
kanal adı + TvProvider `_id` döndürür. 1, 2, 3… numaraları tek tek sorgulanır; adında o numara geçmeyen
sonuç o numaranın sahibidir. Adı kendi numarasını içeren kanallar (ör. "24 HD") eleme ile çözülür ve
arayüzde "tahmini no" etiketiyle gösterilir. Bu TV'de 370 kanalın tamamı numaralandı.

**Uygulama:** Planlayıcı hedef sıraya ulaşmak için gereken **en az** taşıma sayısını hesaplar
(en uzun artan alt dizi yerinde kalır). Her taşıma için:
kaynak kanala gidilir → OK (kanal tutulur) → SAĞ + OK (numara diyaloğu) → hedef numara yazılır →
"Tamam" → ekrandaki satırlar beklenen yeni sırayla karşılaştırılır. Taşıma başına ~30 sn (gerçek TV ölçümü).

## Güvenlik

- Root, bootloader, uygulama kaldırma, kanal silme, fabrika ayarı: **yok**.
- Taşıma modu açıkken YUKARI/AŞAĞI tuşu **asla** gönderilmez (TV'de bu tuşlar kanalı kaydırır).
- Her adımdan sonra ekran `uiautomator` ile okunur; beklenmeyen durumda taşıma modu değişiklik
  yapmadan kapatılır (kaynak = hedef iken OK) ve işlem durur.
- Uygulama yalnızca açık onayla başlar; varsayılan mod **tek taşımalık denemedir**.
- Her okuma `backups/kanal-yedek-*.json|csv`, her uygulama öncesi hedef sıra `backups/kanal-hedef-*`,
  her başarılı taşıma `data/islem-gunlugu-*.jsonl` olarak kaydedilir.
- Sunucu yalnızca `127.0.0.1` üzerinde dinler.

## Sınırlar

- Ham kanal veritabanı (frekans, PID vb.) root olmadan alınamaz; yedekler kanal **sırasının** kopyasıdır
  ve bu araçla TV'ye geri uygulanabilir.
- TV'ye uygulama sırasında TV'de "Kanalları yeniden düzenle" ekranı açık olmalı ve kumandaya
  dokunulmamalıdır (izlemek için `scrcpy`).
- Otomasyon LiveTV 3.3.143.2 ekran kimliklerine dayanır; TV yazılımı güncellenirse ekran
  kimlikleri değişebilir. Bu durumda araç ilk adımda durur, TV'de değişiklik yapmaz.

## Testler

```bash
npm test         # planlayıcı, çift kanal kuralı, okuma çözümleyicisi, ekran ayrıştırıcısı, otomasyon
npm run typecheck
```
