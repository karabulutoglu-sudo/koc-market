# Koç Market — Tauri Sürümü (2.0.4)

Electron uygulamasının Tauri'ye taşınmış hâli. **Electron dosyalarına dokunulmadı**;
Tauri her şeyiyle bu `tauri/` klasöründe yaşar. `index.html` ana klasörde tek kaynak
olarak kalır — iki uygulama da aynı dosyayı kullanır.

## Klasör yapısı

```
KocMarket/
├─ index.html, cari-core.js, barcode-core.js   ← ORTAK uygulama (değişmedi)
├─ main.js, preload.js, package.json            ← Electron (değişmedi)
├─ .github/workflows/build.yml                  ← Electron derleme (v* etiketi)
├─ .github/workflows/tauri-build.yml            ← Tauri derleme (tauri-v* etiketi)
└─ tauri/
   ├─ RELEASE_NOTES.md        ← her sürümde güncelle (sürüm numarası geçmeli)
   ├─ scripts/hazirla.mjs     ← index.html kopyasını hazırlar, CDN → yerel
   ├─ scripts/electron-kopru.mjs ← Electron'un güncellemeyle Tauri'ye geçmesi
   ├─ _GIZLI_ANAHTAR/         ← güncelleme imza anahtarı (GitHub'a GİTMEZ)
   └─ src-tauri/
      ├─ tauri.conf.json      ← sürüm numarası burada
      ├─ src/lib.rs           ← ana süreç (main.js karşılığı)
      ├─ src/store.rs         ← SQLite depo + Electron'dan veri taşıma
      └─ src/bridge.js        ← kocStore/kocDB/kocFile köprüsü (preload.js karşılığı)
```

## Veriler nerede?

| | Electron (eski) | Tauri (yeni) |
|---|---|---|
| Veritabanı | `%APPDATA%\Koç Market\kocmarket.db` | `%APPDATA%\com.kocmarket.app\kocmarket.db` |
| Günlük yedek (7 gün) | `...\Koç Market\backups\` | `...\com.kocmarket.app\backups\` |
| Acil durum aynası | `koc-data.json` | `koc-data.json` |
| Hata günlüğü | `logs\` | `logs\` |

İlk açılışta Tauri, Electron veritabanının **kopyasını** alır, oradan okur, her kaydı
birebir doğrular. Electron dosyalarına yazılmaz, hiçbir şey silinmez. Taşıma öncesi
tam yedek: `backups\electron-gecis-yedek-TARİH.json`.
Veri okunamazsa uygulama **boş açılmaz**, uyarı verip kapanır (Electron verisi yerinde).

> Hatırlatma: JSON yedek dosyası ile programı her zaman birlikte sakla (USB + e-posta).

## TEK SEFERLİK HAZIRLIK

0. `tauri\github-workflow\tauri-build.yml` dosyasını **`.github\workflows\`** klasörüne kopyala
   (Electron'un `build.yml`'ının yanına). Uzaktan yazılamayan korumalı bir klasör olduğu için
   oraya ben koyamadım.
1. GitHub → repo → **Settings → Secrets and variables → Actions → New repository secret**
   - Ad: `TAURI_SIGNING_PRIVATE_KEY`
   - Değer: `tauri/_GIZLI_ANAHTAR/kocmarket-guncelleme.key` dosyasının **içeriği** (Not Defteri ile aç, tamamını kopyala)
2. Bu anahtarı **USB'ye yedekle**. Kaybolursa Tauri güncellemeleri imzalanamaz
   (o zaman bir kez elle kurulum gerekir). E-postaya koyma, GitHub'a yükleme.

## YAYINLAMA (her sürümde)

PowerShell, `C:\KocMarket` içinde:

```powershell
git add .
git commit -m "Tauri 2.0.0"
git push
git tag tauri-v2.0.0
git push origin tauri-v2.0.0
```

GitHub Actions ~10-15 dk'da kurulum dosyasını üretir ve **ÖN SÜRÜM (pre-release)**
olarak yayınlar. Ön sürümü marketteki uygulama GÖRMEZ — önce test edebilirsin.

## TEST → MARKETE DAĞITIM

1. GitHub → Releases → `tauri-v2.0.0` → `koc-market-tauri-setup-2.0.0.exe` indir,
   **bu bilgisayarda** kur ve dene (bu bilgisayardaki Electron verisini taşır).
2. Her şey yolundaysa aynı sayfada **Edit → "Set as the latest release"** işaretle,
   "Set as a pre-release" işaretini kaldır → **Update release**.
3. Marketteki Electron bir sonraki açılışta "Koç Market 2.0.0 güncellemesi hazır" der.
   - "Güncellemeyi Kur" → Tauri kurulumu açılır (bir kerelik ekran).
   - "Daha Sonra" → uygulama kapatılınca sessizce kurulur.
4. Masaüstündeki "Koç Market" kısayolu artık Tauri'yi açar, veriler taşınmış olur.

## Sonraki sürümler

`tauri/src-tauri/tauri.conf.json` ve `tauri/package.json` içindeki `version`'ı artır,
`tauri/RELEASE_NOTES.md`'yi güncelle, `tauri-vX.Y.Z` etiketiyle yayınla, test et,
"latest" yap. Tauri kendi güncelleyicisiyle "Güncellemeyi Kur / Daha Sonra" sorar.

## Electron'u kaldırma (acele yok)

Birkaç hafta sorunsuz çalıştıktan sonra Ayarlar → Uygulamalar'da **eski** "Koç Market"i
kaldırabilirsin (iki tane görünür; Electron olanın sürümü 1.1.0). Electron kaldırıcısı
aynı adlı masaüstü kısayolunu da silebilir — silerse Tauri kurulumunu tekrar çalıştır
(veri etkilenmez). Electron'un veri klasörü kaldırmada silinmez.

## Yerelde deneme (isteğe bağlı)

Rust + Visual Studio Build Tools kuruluysa: `cd tauri`, `npm ci`, `npm run dev`.
Geliştirme modunda güncelleyici çalışmaz.

## 2.0.2 — Türkçe karakter düzeltmesi

Açılış verisi eskiden `<head>` etiketinin hemen arkasına, UTF-8 bildiriminden
önce ekleniyordu. Büyük veri bu bildirimi ilk 1024 bayttan dışarı itebiliyordu.
`src-tauri/src/bootstrap.rs` artık veriyi UTF-8 bildiriminden sonra ekler;
`lib.rs` HTML yanıtına `text/html; charset=utf-8` başlığını koyar. Açılış verisinin
tamamı ve köprü kodu ASCII JS kaçışlarıyla aktarılır. Ürünler, satışlar, cariler,
raporlar, dosya yolları ve emoji bu aktarım sırasında aynen korunur.

Bu düzeltme kaydedilmiş bozuk metinleri otomatik onarmaz. Önce düzeltilmiş sürüm
markette kurulup kontrol edilmeli; ardından güncel veri yedeklenmeli, onarım
önizlemesi incelenmeli ve yalnız onaylanan değişiklikler uygulanmalıdır. Temiz
eski yedeği geri yüklemek yeni satışları kaybettirebileceği için onarımın yerine
geçmez.

Kontroller (`tauri/` içinde):

```powershell
npm test
npm run test:rust
```

Rust kuruluysa test, gerçek açılış HTML'ini üretir; Windows-1252 ile okuyup köprüyü
çalıştırır ve beş açılış/kayıt turunda Türkçe adları, barkodları, tutarları ve yeni
satışların korunmasını doğrular. Ayrıca 2 MB veriyle UTF-8 bildiriminin başta
kaldığı sınanır. Rust bulunmazsa yeniden açılış testi atlanır; `test:rust` Rust
gerektirir. Yayın iş akışı Rust kurar ve iki kontrolü de paket üretiminden önce
çalıştırır.

## 2.0.3 — Kaydedilmiş bozuk adları onarma

Markette güncellemeden sonra açık satışı tamamlayın veya beklemeye alın.
Sağ alttaki **Türkçe Adları Onar** düğmesine basın. Güncel deponun tamamı
`backups/turkce-onarim-oncesi-*.json` dosyasına yedeklenir ve yeniden okunarak
doğrulanır. Önizlemedeki adlar doğruysa **Onar ve Yenile** düğmesine basın.

Eski bir yedek geri yüklenmez. Dört canlı JSON veri alanındaki metinler ve kendi
kurtarma kopyaları onarılır; barkod/kimlik alanları, sayılar, nesne anahtarları ve
kayıt sayıları korunur. Arşiv yedekler değiştirilmez. Eksik veya kayıplı kodlama
nedeniyle kesin çözülemeyen alanlar olduğu gibi kalır; sayısı önizlemede gösterilir.
Önizleme sırasında yazma kilitlenir; tüm snapshot değişmişse onarım reddedilir.
SQLite işlemi tek transaction, JSON motoru atomik dosya yazımı kullanır.

Yayın kontrolü ayrıca `npm run hazirla` ve
`cargo test --manifest-path src-tauri/Cargo.toml --locked --lib` çalıştırır;
algoritma, iki depolama motoru, yedek doğrulama, işlem geri alma, yazma kuyruğu
ve onay ekranı sınanır. Canlı market verisi bu testlerde kullanılmaz.

## 2.0.4 — Görünmeyen karakterli bozulmaları çözme

2.0.3 yalnızca Windows-1252'nin görünür karşılıklarını tanıyordu. Bazı verilerde
aynı katmanda Latin-1'in U+0080–U+009F kontrol karakterleri de bulunuyor. Yeni
onarım her iki gösterimi de aynı byte'a geri çevirir; yalnız geçerli UTF-8 dizileri
çözülür. Sonuçta kalan kontrol karakterleri veya kayıplı U+FFFD alanları reddedilir.

Gerçek başarısız yedeğin ayrı kopyasında eski algoritmanın sıfır düzeltme sonucu
yeniden üretildi; yeni algoritmayla tüm çözülemeyen alanlar geri açıldı. Kaydetme,
yeniden açılış, ikinci onarımın değişiklik yapmaması ve bütün sayısal/kimlik
alanlarının korunması doğrulandı. Kullanıcı verisi kaynak koduna veya yayın
paketine eklenmez; kalıcı regresyon testinde anonim bir karakter örüntüsü kullanılır.
