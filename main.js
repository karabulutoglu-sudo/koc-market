const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const { autoUpdater } = require('electron-updater')
const fs = require('fs')
const path = require('path')
const { createHash, randomUUID } = require('crypto')
const { assertAuthorized, createSession, pinKey, startupMigrations } = require('./native-authorization')
const admin = createSession()

const isDev = !app.isPackaged

let mainWindow

// ───────────────────────────────────────────────────────────────
// DEPOLAMA — SQLite (better-sqlite3) ana motor, JSON dosyası fallback.
//
// Şema: kv(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)
//   Mevcut anahtar→string yapısı AYNEN korunur (koc-prods, koc-sales, ...).
// Okumalar: açılışta tüm kv belleğe (memStore) yüklenir, senkron IPC
//   bellekteki kopyadan cevap verir (write-through cache).
// Yazmalar: önce kalıcı depo, başarılı işlemden sonra bellek güncellenir.
// SQLite açılamazsa: eski koc-data.json motoruna düşülür, uygulama çökmez.
// Eski koc-data.json hiçbir zaman SİLİNMEZ — acil durum yedeği olarak kalır.
// ───────────────────────────────────────────────────────────────
let dataFilePath = null      // eski JSON deposu (fallback + acil yedek)
let dbFilePath = null        // SQLite: userData\kocmarket.db
let db = null                // better-sqlite3 Database (fallback modunda null)
let usingSqlite = false
let memStore = Object.create(null)
let txApply = null
const commitMarker = 'koc-atomic-last-operation'
const fallbackKey = 'koc-native-json-fallback-v1'
const fallbackAppliedKey = 'json_fallback_applied_v1'
const mirrorStateName = 'koc-json-mirror-state'
let fallbackMarker = null

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

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function mirrorStatePath() { return path.join(path.dirname(dataFilePath), mirrorStateName) }

function readMirrorState() {
  try { return fs.readFileSync(mirrorStatePath(), 'utf8') }
  catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function markMirrorDirty() {
  if (readMirrorState() !== 'dirty') atomicWriteText(mirrorStatePath(), 'dirty')
}

function readJsonSnapshot() {
  let raw
  try { raw = fs.readFileSync(dataFilePath) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON deposu geçersiz.')
  const data = Object.create(null)
  let marker = null
  for (const [key, value] of Object.entries(parsed)) {
    if (key === fallbackKey) {
      marker = JSON.parse(value)
      if (marker?.version !== 1 || !marker.baseline || typeof marker.baseline !== 'object' ||
          Array.isArray(marker.baseline) || Object.hasOwn(marker.baseline, fallbackKey) ||
          Object.values(marker.baseline).some(hash => typeof hash !== 'string' || !/^[a-f\d]{64}$/.test(hash))) {
        throw new Error('JSON kurtarma işareti tanınmıyor.')
      }
    } else {
      data[key] = typeof value === 'string' ? value : JSON.stringify(value)
    }
  }
  return { data, marker, digest: digest(raw) }
}

function loadStoreFromDisk(hadDatabase) {
  const snapshot = readJsonSnapshot()
  if (hadDatabase && !snapshot) throw new Error('SQLite açılamadı ve geçerli JSON aynası yok. Eski kayıtlar korunuyor.')
  const state = readMirrorState()
  let sourceDigest
  if (state?.startsWith('clean:')) {
    const seen = snapshot?.marker ? snapshot.marker.source_digest : snapshot?.digest
    sourceDigest = state.slice('clean:'.length)
    if (seen !== sourceDigest) throw new Error('JSON aynasının güncelliği doğrulanamadı. Kayıtlar korundu.')
  } else if (state !== null || (hadDatabase && (!snapshot?.marker || snapshot.marker.source_digest != null))) {
    throw new Error('SQLite açılamadı ve JSON aynasının güncelliği doğrulanamadı. Kayıtlar korundu; SQLite erişimi düzeltilmeli.')
  }
  memStore = snapshot?.data || Object.create(null)
  fallbackMarker = snapshot?.marker || {
    version: 1, baseline: Object.fromEntries(Object.entries(memStore).map(([key, value]) => [key, digest(value)])),
    source_digest: sourceDigest
  }
}

// Atomik yazım (yalnızca JSON fallback modunda kullanılır):
// önce .tmp dosyasına yaz + fsync, sonra rename et.
function atomicWriteText(filename, text) {
  const tmp = filename + '.' + randomUUID() + '.tmp'
  try {
    const fd = fs.openSync(tmp, 'wx')
    try {
      fs.writeFileSync(fd, text, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, filename)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch (_) {}
    throw error
  }
}

function persistStoreToDisk(next = memStore) {
  const data = fallbackMarker ? { ...next, [fallbackKey]: JSON.stringify(fallbackMarker) } : next
  atomicWriteText(dataFilePath, JSON.stringify(data))
}

function readSqliteSnapshot() {
  const data = Object.create(null)
  for (const row of db.prepare('SELECT key, value FROM kv').iterate()) data[row.key] = row.value ?? ''
  return data
}

function sameData(first, second) {
  const keys = Object.keys(first)
  return keys.length === Object.keys(second).length && keys.every(key => first[key] === second[key])
}

function salesIndex(raw = '[]') {
  const sales = JSON.parse(raw)
  if (!Array.isArray(sales)) throw new Error('Satış kaydı listesi geçersiz.')
  const indexed = new Map()
  for (const sale of sales) {
    if (!sale || (typeof sale.id !== 'number' && (typeof sale.id !== 'string' || !sale.id))) {
      throw new Error('Satış kimliği geçersiz.')
    }
    const id = String(sale.id)
    if (indexed.has(id)) throw new Error('Yinelenen satış kimliği var; kayıtlar ayrı yedeklerde tutuldu.')
    indexed.set(id, sale)
  }
  return indexed
}

function hasUnsyncedSales(sqlite, json) {
  if (sqlite['koc-sales'] === json['koc-sales']) return false
  const sqlSales = salesIndex(sqlite['koc-sales'])
  const jsonSales = salesIndex(json['koc-sales'])
  const { isDeepStrictEqual } = require('node:util')
  return Array.from(jsonSales).some(([id, sale]) => !isDeepStrictEqual(sqlSales.get(id), sale))
}

function mergeFallback(sqlite, json, baseline) {
  if (Object.keys(sqlite).length === 0) {
    salesIndex(json['koc-sales'])
    return json
  }
  const merged = Object.create(null)
  for (const key of new Set([...Object.keys(sqlite), ...Object.keys(json)])) {
    const sqlValue = sqlite[key], jsonValue = json[key]
    const base = Object.hasOwn(baseline, key) ? baseline[key] : undefined
    const jsonHash = jsonValue === undefined ? undefined : digest(jsonValue)
    const sqlHash = sqlValue === undefined ? undefined : digest(sqlValue)
    let value
    if (sqlValue === jsonValue || jsonHash === base) value = sqlValue
    else if (sqlHash === base) value = jsonValue
    else throw new Error('SQLite ve JSON aynı alanı farklı değiştirdi: ' + key + '. İki doğrulanmış yedek korundu.')
    if (value !== undefined) merged[key] = value
  }
  if (sqlite['koc-sales'] !== merged['koc-sales']) salesIndex(merged['koc-sales'])
  return merged
}

function recoveryBackup(data, source) {
  const backups = path.join(path.dirname(dataFilePath), 'backups')
  fs.mkdirSync(backups, { recursive: true })
  const name = 'json-uzlastirma-oncesi-' + Date.now() + '-' + randomUUID() + '-' + source + '.json'
  const target = path.join(backups, name)
  const bytes = require('node:buffer').Buffer.from(JSON.stringify(data))
  const fd = fs.openSync(target, 'wx')
  try {
    fs.writeFileSync(fd, bytes)
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  if (!fs.readFileSync(target).equals(bytes)) throw new Error('Uzlaştırma yedeği doğrulanamadı.')
}

function reconcileJsonFallback() {
  const snapshot = readJsonSnapshot()
  if (!snapshot) return
  const previous = db.prepare('SELECT value FROM meta WHERE key = ?').get(fallbackAppliedKey)
  if (previous?.value === snapshot.digest) return
  const reconcile = db.transaction(() => {
    const sqlite = readSqliteSnapshot(), json = snapshot.data
    if (!snapshot.marker && sameData(sqlite, json)) return
    recoveryBackup(sqlite, 'sqlite')
    recoveryBackup(json, 'fallback')
    let merged
    if (snapshot.marker || Object.keys(sqlite).length === 0) {
      merged = mergeFallback(sqlite, json, snapshot.marker?.baseline)
    } else {
      if (hasUnsyncedSales(sqlite, json)) {
        throw new Error('Eski JSON dosyasında SQLite ile eşleşmeyen satış var. İki doğrulanmış yedek korundu.')
      }
      logError('Önceki JSON aynası SQLite ile farklıydı; her iki kaynak doğrulanmış yedek olarak saklandı.')
      merged = sqlite
    }
    if (hasUnsyncedSales(merged, json)) throw new Error('JSON satışları uzlaştırma sonucunda eksik kalacaktı.')
    markMirrorDirty()
    const set = db.prepare('INSERT INTO kv (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
    const del = db.prepare('DELETE FROM kv WHERE key=?')
    const now = new Date().toISOString()
    for (const key of Object.keys(sqlite)) if (!Object.hasOwn(merged, key)) del.run(key)
    for (const [key, value] of Object.entries(merged)) if (sqlite[key] !== value) set.run(key, value, now)
    if (!sameData(readSqliteSnapshot(), merged)) throw new Error('SQLite uzlaştırma sonucu doğrulanamadı.')
    db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)').run(fallbackAppliedKey, snapshot.digest)
  })
  // better-sqlite3 üzerinde karşılaştırma boyunca diğer SQLite yazımlarını engelle.
  if (reconcile.immediate) reconcile.immediate()
  else reconcile()
}

// Eski kurulumlar bu bayrakla JSON'dan geçişin tamamlandığını tanır.
function markLegacyMigrationDone() {
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('migration_done', ?)").run(new Date().toISOString())
}

class JsonRecoveryError extends Error {}

// ── SQLite motorunu başlat. Hata fırlatırsa çağıran fallback'e döner. ──
function initSqlite() {
  const Database = require('better-sqlite3')
  db = new Database(dbFilePath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = FULL')
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')

  try {
    reconcileJsonFallback()
    markLegacyMigrationDone()
  } catch (error) {
    throw new JsonRecoveryError('Veri uzlaştırması tamamlanamadı: ' + error.message)
  }

  // Tüm veriyi belleğe yükle — pencere açılmadan ÖNCE çağrıldığı için
  // satış ekranı hiçbir zaman verisiz başlamaz.
  memStore = readSqliteSnapshot()

  const set = db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ' +
                         'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
  const del = db.prepare('DELETE FROM kv WHERE key=?')
  txApply = db.transaction((entries) => {
    const at = new Date().toISOString()
    for (const [key, val] of entries) {
      if (val === null) del.run(key)
      else set.run(key, val, at)
    }
  })
  usingSqlite = true
}

// ── Ortak yazma/silme: bellek + kalıcı depo (SQLite ya da JSON fallback) ──
function applyStoreEntries(entries) {
  if (entries.some(([key]) => key === fallbackKey)) throw new Error('Yerel kurtarma işareti değiştirilemez.')
  if (entries.length === 0) return
  const next = usingSqlite ? memStore : Object.assign(Object.create(null), memStore)
  if (usingSqlite) {
    markMirrorDirty()
    txApply(entries)
  }
  for (const [key, val] of entries) {
    if (val === null) delete next[key]
    else next[key] = val
  }
  if (!usingSqlite) persistStoreToDisk(next)
  memStore = next
}

function storeCommit(operationId, entries) {
  if (typeof operationId !== 'string' || !operationId.trim()) throw new Error('Geçerli işlem kimliği gerekli.')
  if (memStore[commitMarker] === operationId) return { alreadyCommitted: true }
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Geçerli kayıt grubu gerekli.')
  const changes = Object.entries(entries)
  if (!changes.length || changes.some(([key, val]) => !key || key === commitMarker || (val !== null && typeof val !== 'string'))) {
    throw new Error('Kayıt grubu geçersiz.')
  }
  changes.push([commitMarker, operationId])
  assertAuthorized(memStore, changes, admin.authenticated())
  applyStoreEntries(changes)
  return { alreadyCommitted: false }
}

function storeSet(key, val) {
  try {
    if (String(key) === commitMarker) return false
    const changes = [[String(key), String(val)]]
    assertAuthorized(memStore, changes, admin.authenticated())
    applyStoreEntries(changes)
    return true
  } catch (err) {
    logError('Yazma hatası (' + key + '): ' + err.message)
    return false
  }
}

function storeRemove(key) {
  try {
    if (String(key) === commitMarker) return false
    if (Object.prototype.hasOwnProperty.call(memStore, key)) {
      const changes = [[String(key), null]]
      assertAuthorized(memStore, changes, admin.authenticated())
      applyStoreEntries(changes)
    }
    return true
  } catch (err) {
    logError('Silme hatası (' + key + '): ' + err.message)
    return false
  }
}

function storeGet(key) {
  if (pinKey(String(key))) return null
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
  try {
    synchronizeLegacyMirror()
  } catch (err) {
    logError('Acil durum aynası (koc-data.json) güncellenemedi: ' + err.message)
  }
}

function synchronizeLegacyMirror() {
  if (!usingSqlite || Object.keys(memStore).length === 0) return
  const snapshot = readJsonSnapshot()
  if (snapshot?.marker && db.prepare('SELECT value FROM meta WHERE key = ?').get(fallbackAppliedKey)?.value !== snapshot.digest) {
    throw new Error('Uzlaştırılmamış JSON kaydı korunuyor; ayna güncellenmedi.')
  }
  if (snapshot && !snapshot.marker && sameData(snapshot.data, memStore)
      && readMirrorState() === 'clean:' + snapshot.digest) return
  markMirrorDirty()
  const text = JSON.stringify(memStore)
  atomicWriteText(dataFilePath, text)
  const saved = fs.readFileSync(dataFilePath, 'utf8')
  if (saved !== text) throw new Error('Yazılan JSON aynası doğrulanamadı.')
  atomicWriteText(mirrorStatePath(), 'clean:' + digest(saved))
}

function setupDataStore() {
  dataFilePath = path.join(app.getPath('userData'), 'koc-data.json')
  dbFilePath = path.join(app.getPath('userData'), 'kocmarket.db')
  const hadDatabase = fs.existsSync(dbFilePath)

  try {
    initSqlite()
    console.log('[DB] SQLite aktif:', dbFilePath)
  } catch (err) {
    // ÇELİK KASA KURALI: DB açılamazsa uygulama ÇÖKMEZ — eski JSON motoruyla devam.
    usingSqlite = false
    if (db) { try { db.close() } catch (_) {} db = null }
    if (err instanceof JsonRecoveryError) throw err
    logError('SQLite başlatılamadı, JSON fallback aktif: ' + err.message)
    loadStoreFromDisk(hadDatabase)
  }
  const migrations = startupMigrations(memStore, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'))
  if (migrations.length) applyStoreEntries(migrations)
  synchronizeLegacyMirror()

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
    e.returnValue = Object.keys(memStore).filter(k => !pinKey(k))
  })

  ipcMain.handle('kocstore:commit', (_event, { operationId, entries }) => {
    try {
      return storeCommit(operationId, entries)
    } catch (err) {
      logError('Toplu kayıt hatası: ' + err.message)
      throw err
    }
  })
  ipcMain.handle('admin:status', () => admin.status())
  ipcMain.handle('admin:lock', () => admin.lock())
  ipcMain.handle('admin:unlock', (_event, pin) => admin.unlock(memStore, pin, applyStoreEntries))
  ipcMain.handle('admin:change-pin', (_event, { currentPin,newPin }) =>
    admin.changePin(memStore, currentPin, newPin, applyStoreEntries))

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
    e.returnValue = Object.fromEntries(Object.entries(memStore).filter(([key]) => !pinKey(key)))
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

  function formatReleaseNotes(info) {
    const raw = info && info.releaseNotes
    let text = ''
    if (typeof raw === 'string') {
      text = raw
    } else if (Array.isArray(raw)) {
      text = raw.map(item => {
        if (typeof item === 'string') return item
        return item && (item.note || item.notes || item.releaseNotes) || ''
      }).filter(Boolean).join('\n')
    }

    // GitHub notları Markdown gelir. Electron bilgi kutusunda okunaklı düz metne çevir.
    text = text
      .replace(/\r/g, '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*]\s+/gm, '• ')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .trim()

    return text || 'Bu sürüm için ayrıntılı güncelleme notu bulunmuyor.'
  }

  // ÖNEMLİ: Dinleyiciyi checkForUpdates()'ten ÖNCE kaydet. Güncelleme önceki
  // oturumda zaten indirilmişse 'update-downloaded' kontrol sırasında hemen
  // tetiklenebilir; dinleyici sonra kaydedilirse bu olay kaçar ve pencere çıkmazdı.
  autoUpdater.on('update-downloaded', (info) => {
    if (updatePromptShown) return  // aynı oturumda tek sefer sor (çift pencere olmasın)
    updatePromptShown = true
    const version = info && info.version ? info.version : 'yeni sürüm'
    const notes = formatReleaseNotes(info)
    dialog.showMessageBox({
      type: 'info',
      title: 'Güncelleme Hazır',
      message: 'Koç Market ' + version + ' güncellemesi hazır.',
      detail: 'BU GÜNCELLEMEDE:\n\n' + notes + '\n\nŞimdi kurulup uygulama yeniden başlatılsın mı?',
      buttons: ['Güncellemeyi Kur', 'Daha Sonra'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
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
  if (!app.requestSingleInstanceLock()) { app.quit(); return }
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore()
    mainWindow?.focus()
  })
  try {
    setupDataStore()
  } catch (error) {
    logError('Veri deposu açılmadı: ' + error.message)
    dialog.showErrorBox('Koç Market veri deposu', error.message)
    app.quit()
    return
  }
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
