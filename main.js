const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const { autoUpdater } = require('electron-updater')
const fs = require('fs')
const path = require('path')

const isDev = !app.isPackaged

let mainWindow

// ───────────────────────────────────────────────────────────────
// DEPOLAMA — SQLite (better-sqlite3) ana motor, JSON dosyası fallback.
//
// Şema: kv(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)
//   Mevcut anahtar→string yapısı AYNEN korunur (koc-prods, koc-sales, ...).
// Okumalar: açılışta tüm kv belleğe (memStore) yüklenir, senkron IPC
//   bellekteki kopyadan cevap verir (write-through cache).
// Yazmalar: önce bellek, sonra SQLite transaction (WAL + synchronous=FULL).
// SQLite açılamazsa: eski koc-data.json motoruna düşülür, uygulama çökmez.
// Eski koc-data.json hiçbir zaman SİLİNMEZ — acil durum yedeği olarak kalır.
// ───────────────────────────────────────────────────────────────
let dataFilePath = null      // eski JSON deposu (fallback + acil yedek)
let dbFilePath = null        // SQLite: userData\kocmarket.db
let db = null                // better-sqlite3 Database (fallback modunda null)
let usingSqlite = false
let memStore = {}
let sqlSet = null, sqlDel = null   // hazırlanmış statement'lar
let txSet = null, txDel = null     // transaction sarmalayıcıları

// ── Hata günlüğü: userData\logs\db-YYYY-MM-DD.log ──
function logError(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg + '\n'
  console.error('[DB]', msg)
  try {
    const logsDir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
    const fname = 'db-' + new Date().toISOString().slice(0, 10) + '.log'
    fs.appendFileSync(path.join(logsDir, fname), line, 'utf8')
  } catch (_) { /* günlük yazılamıyorsa sessiz geç — satışı engelleme */ }
}

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

// Atomik yazım (yalnızca JSON fallback modunda kullanılır):
// önce .tmp dosyasına yaz + fsync, sonra rename et.
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

// ── Eski JSON deposunu (varsa) oku, memStore'a DOKUNMADAN obje döndür ──
function readLegacyJson() {
  try {
    const raw = fs.readFileSync(dataFilePath, 'utf8')
    const obj = JSON.parse(raw)
    return (obj && typeof obj === 'object') ? obj : {}
  } catch (_) {
    return {}
  }
}

// ── TEK SEFERLİK GEÇİŞ: koc-data.json → SQLite ──
// İdempotent: meta tablosundaki migration_done bayrağı varsa hiç dokunmaz.
// Taşıma öncesi tam JSON yedek alınır; taşıma sonrası anahtar sayısı ve
// TÜM değerler doğrulanır. Tutarsızlıkta geçiş iptal edilir (hata fırlatılır
// → çağıran fallback'e düşer). Eski koc-data.json asla silinmez.
function migrateLegacyToSqlite() {
  const done = db.prepare("SELECT value FROM meta WHERE key='migration_done'").get()
  if (done) return

  const legacy = readLegacyJson()
  const legacyKeys = Object.keys(legacy)
  const rowCount = db.prepare('SELECT COUNT(*) AS n FROM kv').get().n

  if (rowCount === 0 && legacyKeys.length > 0) {
    // 1) Taşıma ÖNCESİ tam yedek: backups\migration-yedek-YYYY-MM-DD-HHmm.json
    const backupsDir = path.join(app.getPath('userData'), 'backups')
    fs.mkdirSync(backupsDir, { recursive: true })
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
                  '-' + pad(d.getHours()) + pad(d.getMinutes())
    fs.writeFileSync(path.join(backupsDir, 'migration-yedek-' + stamp + '.json'),
                     JSON.stringify(legacy), 'utf8')

    // 2) Tüm anahtarları tek transaction içinde taşı
    const now = new Date().toISOString()
    const ins = db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
    db.transaction(() => {
      for (const k of legacyKeys) ins.run(k, String(legacy[k]), now)
    })()

    // 3) Doğrulama: sayı + her değerin birebir eşleşmesi
    const newCount = db.prepare('SELECT COUNT(*) AS n FROM kv').get().n
    if (newCount !== legacyKeys.length) {
      db.prepare('DELETE FROM kv').run()
      throw new Error('Migration doğrulaması başarısız: satır sayısı uyuşmuyor (' +
                      newCount + ' ≠ ' + legacyKeys.length + ')')
    }
    const sel = db.prepare('SELECT value FROM kv WHERE key=?')
    for (const k of legacyKeys) {
      const row = sel.get(k)
      if (!row || row.value !== String(legacy[k])) {
        db.prepare('DELETE FROM kv').run()
        throw new Error('Migration doğrulaması başarısız: "' + k + '" değeri uyuşmuyor')
      }
    }
    console.log('[DB] Migration tamam: ' + legacyKeys.length +
                ' anahtar koc-data.json → kocmarket.db taşındı (eski dosya yedek olarak duruyor).')
  }

  db.prepare("INSERT INTO meta (key, value) VALUES ('migration_done', ?)").run(new Date().toISOString())
}

// ── SQLite motorunu başlat. Hata fırlatırsa çağıran fallback'e döner. ──
function initSqlite() {
  const Database = require('better-sqlite3')
  dbFilePath = path.join(app.getPath('userData'), 'kocmarket.db')
  db = new Database(dbFilePath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = FULL')
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')

  migrateLegacyToSqlite()

  // Tüm veriyi belleğe yükle — pencere açılmadan ÖNCE çağrıldığı için
  // satış ekranı hiçbir zaman verisiz başlamaz.
  memStore = {}
  for (const row of db.prepare('SELECT key, value FROM kv').iterate()) {
    memStore[row.key] = row.value
  }

  sqlSet = db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ' +
                      'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
  sqlDel = db.prepare('DELETE FROM kv WHERE key=?')
  txSet = db.transaction((key, val) => { sqlSet.run(key, val, new Date().toISOString()) })
  txDel = db.transaction((key) => { sqlDel.run(key) })
  usingSqlite = true
}

// ── Ortak yazma/silme: bellek + kalıcı depo (SQLite ya da JSON fallback) ──
function storeSet(key, val) {
  try {
    memStore[key] = String(val)
    if (usingSqlite) txSet(key, String(val))
    else persistStoreToDisk()
    return true
  } catch (err) {
    logError('Yazma hatası (' + key + '): ' + err.message)
    return false
  }
}

function storeRemove(key) {
  try {
    if (Object.prototype.hasOwnProperty.call(memStore, key)) {
      delete memStore[key]
      if (usingSqlite) txDel(key)
      else persistStoreToDisk()
    }
    return true
  } catch (err) {
    logError('Silme hatası (' + key + '): ' + err.message)
    return false
  }
}

function storeGet(key) {
  return Object.prototype.hasOwnProperty.call(memStore, key) ? memStore[key] : null
}

// ── GÜNLÜK OTOMATİK YEDEK: backups\gunluk-yedek-YYYY-MM-DD.json ──
// Açılışta arka planda çalışır; satışı asla bloklamaz, pencere göstermez.
// Son 7 günlük dosya tutulur, eskiler silinir.
function runDailyBackup() {
  setTimeout(() => {
    try {
      const backupsDir = path.join(app.getPath('userData'), 'backups')
      fs.mkdirSync(backupsDir, { recursive: true })
      const today = new Date().toISOString().slice(0, 10)
      const target = path.join(backupsDir, 'gunluk-yedek-' + today + '.json')
      if (!fs.existsSync(target)) {
        const tmp = target + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(memStore), 'utf8')
        fs.renameSync(tmp, target)
        console.log('[YEDEK] Günlük yedek alındı:', target)
      }
      // Eski günlük yedekleri temizle (son 7 kalsın)
      const files = fs.readdirSync(backupsDir)
        .filter(f => /^gunluk-yedek-\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort()
      for (const f of files.slice(0, Math.max(0, files.length - 7))) {
        try { fs.unlinkSync(path.join(backupsDir, f)) } catch (_) {}
      }
      // Acil durum aynası: koc-data.json'u güncel tut ki SQLite günün birinde
      // açılamazsa fallback BAYAT değil güncel veriyle çalışsın.
      refreshLegacyMirror()
    } catch (err) {
      logError('Günlük yedek hatası: ' + err.message)
    }
  }, 3000)
}

// koc-data.json'u SQLite içeriğiyle tazele (atomik). Yalnızca SQLite modunda
// ve bellekte gerçek veri (koc-prods) varken — bozuk/boş veriyle asla ezme.
function refreshLegacyMirror() {
  if (!usingSqlite) return
  if (!memStore['koc-prods']) return
  try {
    persistStoreToDisk()
  } catch (err) {
    logError('Acil durum aynası (koc-data.json) güncellenemedi: ' + err.message)
  }
}

function setupDataStore() {
  dataFilePath = path.join(app.getPath('userData'), 'koc-data.json')

  try {
    initSqlite()
    console.log('[DB] SQLite aktif:', dbFilePath)
  } catch (err) {
    // ÇELİK KASA KURALI: DB açılamazsa uygulama ÇÖKMEZ — eski JSON motoruyla devam.
    usingSqlite = false
    if (db) { try { db.close() } catch (_) {} db = null }
    logError('SQLite başlatılamadı, JSON fallback aktif: ' + err.message)
    loadStoreFromDisk()
  }

  ipcMain.on('kocstore:read', (e, key) => {
    e.returnValue = storeGet(key)
  })

  ipcMain.on('kocstore:write', (e, { key, val }) => {
    e.returnValue = storeSet(key, val)
  })

  ipcMain.on('kocstore:remove', (e, key) => {
    e.returnValue = storeRemove(key)
  })

  ipcMain.on('kocstore:keys', (e) => {
    e.returnValue = Object.keys(memStore)
  })

  // ── Yeni kocDB API'si (preload'daki window.kocDB köprüsü için) ──
  // kocstore:* ile aynı depoyu kullanır; ileride doğrudan bu API'ye geçilebilir.
  ipcMain.on('db-get', (e, key) => {
    e.returnValue = storeGet(String(key))
  })

  ipcMain.on('db-set', (e, { key, val }) => {
    e.returnValue = storeSet(String(key), String(val))
  })

  ipcMain.on('db-delete', (e, key) => {
    e.returnValue = storeRemove(String(key))
  })

  ipcMain.on('db-get-all', (e) => {
    e.returnValue = Object.assign({}, memStore)
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

  // NOT: Bu noktada eskiden "odak kurtarma / zorla öne getirme" kodları vardı
  // (webContents.focus handlers, setInterval bekçi, küçült/aç reclaim). Asıl
  // odak çalma sebebi OneDrive senkronuydu; proje OneDrive dışına alınınca çözüldü.
  // O yamalar tamamen kaldırıldı — pencere artık düz, normal bir Electron penceresi.

  mainWindow.on('closed', () => { mainWindow = null })
}

function setupAutoUpdater() {
  if (!app.isPackaged) return

  let updatePromptShown = false

  // ÖNEMLİ: Dinleyiciyi checkForUpdates()'ten ÖNCE kaydet. Güncelleme önceki
  // oturumda zaten indirilmişse 'update-downloaded' kontrol sırasında hemen
  // tetiklenebilir; dinleyici sonra kaydedilirse bu olay kaçar ve pencere çıkmazdı.
  autoUpdater.on('update-downloaded', () => {
    if (updatePromptShown) return  // aynı oturumda tek sefer sor (çift pencere olmasın)
    updatePromptShown = true
    dialog.showMessageBox({
      type: 'info',
      title: 'Güncelleme Hazır',
      message: 'Yeni güncelleme mevcut. Yüklensin mi?',
      buttons: ['Evet', 'Hayır']
    }).then(result => {
      if (result.response === 0) autoUpdater.quitAndInstall()
      else updatePromptShown = false  // "Hayır" derse ileride tekrar sorulabilsin
    })
  })

  autoUpdater.on('error', (err) => {
    console.error('[AUTO-UPDATE] hata:', err == null ? 'bilinmeyen' : (err.message || err))
  })

  autoUpdater.checkForUpdates().catch(() => {})
}

app.whenReady().then(() => {
  setupDataStore()   // IPC + veritabanı pencere açılmadan önce hazır olsun
  createWindow()
  setupAutoUpdater()
  runDailyBackup()   // arka planda günlük JSON yedek (satışı bloklamaz)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Çıkışta: acil durum aynasını tazele + veritabanını düzgün kapat
// (WAL checkpoint'i ana dosyaya işlenir).
app.on('will-quit', () => {
  refreshLegacyMirror()
  if (db) { try { db.close() } catch (_) {} db = null }
})
