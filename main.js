const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

// Production'da geliştirici araçları kapalı
const isDev = !app.isPackaged;

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Koç Market',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      devTools: isDev
    }
  });

  // Menü çubuğunu tamamen kaldır
  mainWindow.setMenuBarVisibility(false);

  mainWindow.loadFile('index.html');

  // Pencere hazır olunca maximize + tam ekran başlat ve göster
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.setFullScreen(true);
    mainWindow.show();
  });

  // Production'da DevTools kısayollarını ve sağ tık menüsünü engelle
  if (!isDev) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const key = (input.key || '').toLowerCase();
      // F12 ve Ctrl+Shift+I gibi DevTools kısayollarını engelle
      if (key === 'f12') {
        event.preventDefault();
      }
      if (input.control && input.shift && (key === 'i' || key === 'j' || key === 'c')) {
        event.preventDefault();
      }
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- Otomatik güncelleme (electron-updater + GitHub Releases) ---
function setupAutoUpdater() {
  // Geliştirme ortamında güncelleme kontrolü yapma
  if (isDev) {
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // Güncelleme bulundu -> kullanıcıya Türkçe sor
  autoUpdater.on('update-available', (info) => {
    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        title: 'Güncelleme Mevcut',
        message: 'Yeni güncelleme mevcut. Yüklensin mi?',
        detail: `Yeni sürüm: ${info.version}`,
        buttons: ['Evet, yükle', 'Daha sonra'],
        defaultId: 0,
        cancelId: 1
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.downloadUpdate();
        }
      });
  });

  // İndirme tamamlandı -> kur ve yeniden başlat
  autoUpdater.on('update-downloaded', () => {
    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        title: 'Güncelleme Hazır',
        message: 'Güncelleme indirildi. Uygulama şimdi yeniden başlatılıp kurulum tamamlanacak.',
        buttons: ['Şimdi yeniden başlat', 'Çıkışta kur'],
        defaultId: 0,
        cancelId: 1
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  autoUpdater.on('error', (err) => {
    // Güncelleme hatası uygulamayı durdurmamalı; sessizce logla
    console.error('Güncelleme hatası:', err == null ? 'bilinmiyor' : (err.message || err));
  });

  // Açılışta güncelleme kontrol et.
  // checkForUpdates() bir promise döndürür; repo/sürüm yoksa (404) veya
  // internet yoksa reddedilir. 'error' event'i zaten loglandığı için burada
  // sessizce yakalıyoruz; aksi halde "unhandled rejection" oluşup uygulamayı
  // çökertebilir.
  autoUpdater.checkForUpdates().catch(() => {
    // Hata ayrıca autoUpdater.on('error') içinde loglanıyor.
  });
}

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
