# Koç Market — Masaüstü Uygulaması

Koç Market Satış Sistemi'nin Electron tabanlı Windows masaüstü uygulaması.
GitHub Releases üzerinden otomatik güncelleme (electron-updater) destekler.

---

## 1. Gereksinimler (tek seferlik)

Bilgisayarınızda kurulu olması gerekenler:

- **Node.js 20+** → https://nodejs.org (LTS sürümü)
- **Git** → https://git-scm.com
- Bir **GitHub hesabı**

Kurulumdan sonra kontrol edin:

```powershell
node -v
npm -v
git --version
```

---

## 2. İlk Kurulum (yerel test)

Proje klasöründe (bu README'nin bulunduğu yerde) bir terminal açın ve:

```powershell
npm install
```

Uygulamayı yerelde test etmek için:

```powershell
npm start
```

> Yerel (geliştirme) modunda otomatik güncelleme **çalışmaz**, bu normaldir.
> Güncelleme yalnızca kurulu (installer ile yüklenmiş) sürümde çalışır.

---

## 3. GitHub Reposunu Hazırlama (tek seferlik)

1. GitHub'da **boş bir repo** oluşturun (önerilen ad: `koc-market`).
2. `package.json` dosyasındaki `publish` bölümünde **`owner`** alanını
   kendi GitHub kullanıcı adınızla değiştirin:

   ```json
   "publish": [
     {
       "provider": "github",
       "owner": "GITHUB-KULLANICI-ADIN",
       "repo": "koc-market"
     }
   ]
   ```

3. Yerel projeyi repoya bağlayın ve gönderin:

   ```powershell
   git init
   git add .
   git commit -m "İlk sürüm"
   git branch -M main
   git remote add origin https://github.com/GITHUB-KULLANICI-ADIN/koc-market.git
   git push -u origin main
   ```

---

## 4. İlk Build (yerel olarak installer üretmek)

İnternet bağlantısı olan bilgisayarınızda installer (.exe) üretmek için:

```powershell
npm run dist
```

Üretilen kurulum dosyası `dist/` klasöründe oluşur:
`dist/Koç Market Setup 1.0.0.exe`

> Not: Bu komut sadece installer üretir, GitHub'a **yüklemez**.
> Yayınlama (GitHub Releases'a yükleme) için aşağıdaki adıma bakın.

---

## 5. Güncelleme Yayınlama (her yeni sürümde)

Otomatik güncelleme, GitHub Releases üzerinden çalışır. İki yöntem vardır:

### Yöntem A — GitHub Actions ile (önerilen)

Her şey otomatik. Sadece sürüm numarasını artırıp bir **tag** gönderin:

1. `package.json` içindeki `version` alanını artırın (örn: `1.0.0` → `1.0.1`).
2. Değişiklikleri gönderin:

   ```powershell
   git add .
   git commit -m "Sürüm 1.0.1"
   git push
   ```

3. Aynı numarayla bir tag oluşturup gönderin:

   ```powershell
   git tag v1.0.1
   git push origin v1.0.1
   ```

`v` ile başlayan tag gönderildiğinde GitHub Actions (`.github/workflows/build.yml`)
otomatik olarak:
- Windows x64 NSIS installer üretir,
- GitHub Releases'a yükler.

Yayınlandıktan sonra, kullanıcılarda kurulu olan uygulama bir sonraki açılışta
güncellemeyi bulur ve Türkçe olarak **"Yeni güncelleme mevcut. Yüklensin mi?"**
diye sorar.

> Önemli: `package.json`'daki `version` ile gönderdiğiniz tag (`v1.0.1`) aynı
> numarayı taşımalıdır.

### Yöntem B — Kendi bilgisayarınızdan yayınlama

GitHub Actions kullanmadan, doğrudan kendi bilgisayarınızdan yayınlayabilirsiniz.
Bunun için bir **GitHub Personal Access Token** gerekir:

1. GitHub → Settings → Developer settings → Personal access tokens →
   `repo` yetkili bir token oluşturun.
2. Terminalde token'ı tanımlayıp yayınlayın:

   ```powershell
   $env:GH_TOKEN = "buraya-token"
   npm run publish
   ```

---

## 6. Otomatik Güncelleme Nasıl Çalışır?

- Uygulama her açılışta GitHub Releases'taki en son sürümü kontrol eder.
- Daha yeni bir sürüm varsa Türkçe dialog gösterir.
- Kullanıcı onaylarsa indirilir, ardından yeniden başlatılarak kurulur.

---

## Proje Yapısı

```
.
├── main.js                  # Electron ana process + otomatik güncelleme
├── index.html               # Uygulama arayüzü (koc_market_v14 kopyası)
├── package.json             # Bağımlılıklar + electron-builder ayarları
├── build/                   # Uygulama ikonu (icon.ico) buraya
└── .github/workflows/build.yml  # GitHub Actions otomatik build
```
