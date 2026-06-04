const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const { autoUpdater } = require('electron-updater')
const fs = require('fs')
const path = require('path')

const isDev = !app.isPackaged

let mainWindow

// ───────────────────────────────────────────────────────────────
// DİSK DEPOLAMA — tüm veri tek bir JSON dosyasında: koc-data.json
// Yapı: { "koc-prods": "...", "koc-sales": "...", ... } (anahtar→string)
// Açılışta belleğe okunur; her yazımda bellek güncellenir + atomik diske yazılır.
// ───────────────────────────────────────────────────────────────
let dataFilePath = null
let memStore = {}

function loadStoreFromDisk() {
  try {
    const raw = fs.readFileSync(dataFilePath, 'utf8')
    const obj = JSON.parse(raw)
    memStore = (obj && typeof obj === 'object') ? obj : {}
  } catch (e) {
    // Dosya yoksa (ilk açılış) veya bozuksa boş başla.
    if (e.code !== 'ENOENT') {
      console.error('[KOCSTORE] Veri dosyası okunamadı/bozuk:', e.message)
      // Bozuk dosyayı kaybetmeyelim — yan tarafa kopya al.
      try { fs.copyFileSync(dataFilePath, dataFilePath + '.corrupt-' + Date.now()) } catch (_) {}
    }
    memStore = {}
  }
}

// Atomik yazım: önce .tmp dosyasına yaz + fsync, sonra rename et.
// Yarıda kesilirse asıl dosya bozulmaz.
function persistStoreToDisk() {
  const tmp = dataFilePath + '.tmp'
  const json = JSON.stringify(memStore)
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, json)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, dataFilePath) // Node: Windows'ta da mevcut dosyanın üzerine atomik yazar
}

function setupDataStore() {
  dataFilePath = path.join(app.getPath('userData'), 'koc-data.json')
  loadStoreFromDisk()

  ipcMain.on('kocstore:read', (e, key) => {
    e.returnValue = Object.prototype.hasOwnProperty.call(memStore, key) ? memStore[key] : null
  })

  ipcMain.on('kocstore:write', (e, { key, val }) => {
    try {
      memStore[key] = String(val)
      persistStoreToDisk()
      e.returnValue = true
    } catch (err) {
      console.error('[KOCSTORE] Yazma hatası:', key, err.message)
      e.returnValue = false
    }
  })

  ipcMain.on('kocstore:remove', (e, key) => {
    try {
      if (Object.prototype.hasOwnProperty.call(memStore, key)) {
        delete memStore[key]
        persistStoreToDisk()
      }
      e.returnValue = true
    } catch (err) {
      console.error('[KOCSTORE] Silme hatası:', key, err.message)
      e.returnValue = false
    }
  })

  ipcMain.on('kocstore:keys', (e) => {
    e.returnValue = Object.keys(memStore)
  })

  // ── Dosya pencereleri: gerçek "Farklı Kaydet" / "Aç" (Electron dialog) ──
  ipcMain.handle('kocfile:save', async (e, { defaultName, contents }) => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender)
      const startPath = path.join(app.getPath('desktop'), defaultName || 'koc-yedek.json')
      const r = await dialog.showSaveDialog(win, {
        title: 'Yedeği Kaydet',
        defaultPath: startPath,
        filters: [
          { name: 'Yedek Dosyaları', extensions: ['json', 'csv'] },
          { name: 'Tüm Dosyalar', extensions: ['*'] }
        ]
      })
      if (r.canceled || !r.filePath) return { canceled: true }
      fs.writeFileSync(r.filePath, contents, 'utf8')
      return { ok: true, path: r.filePath }
    } catch (err) {
      console.error('[KOCFILE] Kaydetme hatası:', err.message)
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('kocfile:open', async (e) => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender)
      const r = await dialog.showOpenDialog(win, {
        title: 'Yedek Dosyası Seç',
        properties: ['openFile'],
        filters: [
          { name: 'Yedek Dosyaları', extensions: ['json', 'csv'] },
          { name: 'Tüm Dosyalar', extensions: ['*'] }
        ]
      })
      if (r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true }
      const fp = r.filePaths[0]
      const contents = fs.readFileSync(fp, 'utf8')
      return { ok: true, contents, path: fp }
    } catch (err) {
      console.error('[KOCFILE] Açma hatası:', err.message)
      return { ok: false, error: err.message }
    }
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Koç Market',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      devTools: isDev
    }
  })

  mainWindow.loadFile('index.html')
  mainWindow.maximize()

  // Production'da DevTools kısayollarını engelle (F12, Ctrl+Shift+I/J/C)
  if (!isDev) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const key = (input.key || '').toLowerCase()
      if (key === 'f12') {
        event.preventDefault()
      }
      if (input.control && input.shift && (key === 'i' || key === 'j' || key === 'c')) {
        event.preventDefault()
      }
    })
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

function setupAutoUpdater() {
  if (!app.isPackaged) return
  autoUpdater.checkForUpdates().catch(() => {})
  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Güncelleme Hazır',
      message: 'Yeni güncelleme mevcut. Yüklensin mi?',
      buttons: ['Evet', 'Hayır']
    }).then(result => {
      if (result.response === 0) autoUpdater.quitAndInstall()
    })
  })
}

app.whenReady().then(() => {
  setupDataStore()   // IPC + dosya deposu pencere açılmadan önce hazır olsun
  createWindow()
  setupAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
