// ═══════════════════════════════════════════════════════════════════
// DEPOLAMA — SQLite ana motor, JSON dosyası fallback.
// Electron sürümündeki main.js mantığının birebir Rust karşılığı.
//
// Şema: kv(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)
//       meta(key TEXT PRIMARY KEY, value TEXT)
//   Anahtar→string yapısı AYNEN korunur (koc-prods, koc-sales, ...).
// Okumalar: açılışta tüm kv belleğe (mem) yüklenir.
// Yazmalar: önce bellek, sonra SQLite transaction (WAL + synchronous=FULL).
// SQLite açılamazsa: koc-data.json motoruna düşülür, uygulama çökmez.
//
// ELECTRON'DAN GEÇİŞ (tek seferlik):
//   Electron'un veri klasöründeki kocmarket.db (+ -wal, -shm) dosyalarının
//   KOPYASI alınır, kopyadan okunur. Electron dosyalarına ASLA yazılmaz,
//   hiçbir şey silinmez. Taşıma sonrası sayı + tüm değerler doğrulanır.
// ═══════════════════════════════════════════════════════════════════

use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub type Kv = HashMap<String, String>;

pub struct Store {
    pub dir: PathBuf,
    conn: Option<Connection>,
    pub mem: Kv,
    json_path: PathBuf,
    closed: bool,
}

/// Uygulama açılışında ne olduğunu anlatan rapor (günlüğe + arayüze).
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct InitReport {
    pub engine: String,            // "sqlite" | "json"
    pub migrated_from: Option<String>,
    pub migrated_keys: usize,
    pub warnings: Vec<String>,
}

#[derive(serde::Deserialize, Debug)]
pub struct Op {
    pub key: String,
    pub op: String, // "set" | "del"
    pub val: Option<String>,
}

// ── Yardımcılar ────────────────────────────────────────────────────

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d-%H%M").to_string()
}

/// Hata günlüğü: <veri>\logs\db-YYYY-MM-DD.log — yazılamazsa sessiz geç.
pub fn log_line(dir: &Path, msg: &str) {
    eprintln!("[KOC] {msg}");
    let logs = dir.join("logs");
    let _ = fs::create_dir_all(&logs);
    let fname = format!("db-{}.log", chrono::Local::now().format("%Y-%m-%d"));
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(logs.join(fname)) {
        let _ = writeln!(f, "[{}] {}", now_iso(), msg);
    }
}

/// Atomik yazım: .tmp dosyasına yaz + fsync, sonra rename.
pub fn atomic_write(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("dat")
    ));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

fn mtime(p: &Path) -> Option<SystemTime> {
    fs::metadata(p).and_then(|m| m.modified()).ok()
}

fn read_json_kv(path: &Path) -> Option<Kv> {
    let raw = fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let obj = v.as_object()?;
    let mut out = Kv::new();
    for (k, val) in obj {
        // Electron String(val) ile yazıyordu; string değilse JSON metnine çevir.
        let s = match val {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        out.insert(k.clone(), s);
    }
    Some(out)
}

// ── Electron verisini bul ve oku (salt-okunur, kopya üzerinden) ─────

struct Source {
    desc: String,
    data: Kv,
    newest: Option<SystemTime>,
}

/// Electron db dosyalarını snapshot klasörüne KOPYALA ve kopyadan oku.
fn read_electron_db(src_db: &Path, snap_dir: &Path) -> Result<Kv, String> {
    fs::create_dir_all(snap_dir).map_err(|e| e.to_string())?;
    let dst = snap_dir.join("kocmarket.db");
    fs::copy(src_db, &dst).map_err(|e| format!("db kopyalanamadı: {e}"))?;
    for ext in ["-wal", "-shm"] {
        let s = PathBuf::from(format!("{}{}", src_db.display(), ext));
        if s.exists() {
            let d = PathBuf::from(format!("{}{}", dst.display(), ext));
            fs::copy(&s, &d).map_err(|e| format!("{ext} kopyalanamadı: {e}"))?;
        }
    }
    let conn = Connection::open(&dst).map_err(|e| format!("kopya açılamadı: {e}"))?;
    let mut stmt = conn
        .prepare("SELECT key, value FROM kv")
        .map_err(|e| format!("kv tablosu okunamadı: {e}"))?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut out = Kv::new();
    for row in rows {
        let (k, v) = row.map_err(|e| e.to_string())?;
        out.insert(k, v.unwrap_or_default());
    }
    Ok(out)
}

/// Aday Electron klasörlerinden en güncel veriyi seç.
/// Bir Electron veritabanı VAR ama okunamadıysa Err döner (boş başlamak yerine dur).
fn find_electron_source(candidates: &[PathBuf], snap_root: &Path, dir: &Path) -> Result<Option<Source>, String> {
    let mut best: Option<Source> = None;
    let mut read_errors: Vec<String> = vec![];
    for (i, cand) in candidates.iter().enumerate() {
        if !cand.is_dir() {
            continue;
        }
        let db = cand.join("kocmarket.db");
        let wal = PathBuf::from(format!("{}-wal", db.display()));
        let json = cand.join("koc-data.json");
        let newest = [mtime(&db), mtime(&wal), mtime(&json)].into_iter().flatten().max();

        let mut found: Option<(String, Kv)> = None;
        if db.exists() {
            match read_electron_db(&db, &snap_root.join(format!("kaynak-{i}"))) {
                Ok(d) if !d.is_empty() => found = Some((db.display().to_string(), d)),
                Ok(_) => log_line(dir, &format!("Electron db boş: {}", db.display())),
                Err(e) => {
                    log_line(dir, &format!("Electron db okunamadı ({}): {e}", db.display()));
                    read_errors.push(format!("{}: {e}", db.display()));
                }
            }
        }
        if found.is_none() {
            if let Some(d) = read_json_kv(&json) {
                if !d.is_empty() {
                    found = Some((json.display().to_string(), d));
                }
            }
        }
        if let Some((desc, data)) = found {
            log_line(dir, &format!("Electron verisi bulundu: {desc} ({} anahtar)", data.len()));
            let better = match &best {
                None => true,
                Some(b) => newest > b.newest,
            };
            if better {
                best = Some(Source { desc, data, newest });
            }
        }
    }
    if best.is_none() && !read_errors.is_empty() {
        return Err(format!("Eski Electron veritabanı okunamadı:\n{}", read_errors.join("\n")));
    }
    Ok(best)
}

// ── Store ──────────────────────────────────────────────────────────

impl Store {
    /// Depoyu başlat. Err dönerse uygulama AÇILMAMALI (veri riski).
    pub fn init(dir: PathBuf, electron_candidates: &[PathBuf]) -> Result<(Store, InitReport), String> {
        fs::create_dir_all(&dir).map_err(|e| format!("Veri klasörü oluşturulamadı: {e}"))?;
        let json_path = dir.join("koc-data.json");
        let mut report = InitReport::default();

        match Self::open_sqlite(&dir) {
            Ok(conn) => {
                let mut st = Store { dir: dir.clone(), conn: Some(conn), mem: Kv::new(), json_path, closed: false };
                st.migrate_if_needed(electron_candidates, &mut report)?; // geçiş hatası = açılma
                st.load_mem_from_sqlite().map_err(|e| format!("Veri okunamadı: {e}"))?;
                report.engine = "sqlite".into();
                log_line(&dir, &format!("SQLite aktif: {} anahtar", st.mem.len()));
                Ok((st, report))
            }
            Err(e) => {
                // ÇELİK KASA KURALI: DB açılamazsa uygulama ÇÖKMEZ — JSON motoruyla devam.
                log_line(&dir, &format!("SQLite başlatılamadı, JSON fallback aktif: {e}"));
                report.warnings.push(format!("SQLite açılamadı, yedek motor (JSON) kullanılıyor: {e}"));
                let mut mem = match fs::read_to_string(&json_path) {
                    Ok(raw) => match serde_json::from_str::<Kv>(&raw) {
                        Ok(m) => m,
                        Err(err) => {
                            let _ = fs::copy(&json_path, dir.join(format!("koc-data.json.corrupt-{}", stamp())));
                            log_line(&dir, &format!("koc-data.json bozuk: {err}"));
                            Kv::new()
                        }
                    },
                    Err(_) => Kv::new(),
                };
                if mem.is_empty() {
                    if let Some(src) = find_electron_source(electron_candidates, &dir.join("migration").join(stamp()), &dir)? {
                        report.migrated_from = Some(src.desc.clone());
                        report.migrated_keys = src.data.len();
                        mem = src.data;
                    }
                }
                let st = Store { dir, conn: None, mem, json_path, closed: false };
                st.persist_json().map_err(|e| format!("JSON deposu yazılamadı: {e}"))?;
                report.engine = "json".into();
                Ok((st, report))
            }
        }
    }

    fn open_sqlite(dir: &Path) -> rusqlite::Result<Connection> {
        let conn = Connection::open(dir.join("kocmarket.db"))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
             CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);",
        )?;
        Ok(conn)
    }

    fn load_mem_from_sqlite(&mut self) -> rusqlite::Result<()> {
        let conn = self.conn.as_ref().unwrap();
        let mut stmt = conn.prepare("SELECT key, value FROM kv")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))?;
        self.mem.clear();
        for row in rows {
            let (k, v) = row?;
            self.mem.insert(k, v.unwrap_or_default());
        }
        Ok(())
    }

    /// TEK SEFERLİK GEÇİŞ: Electron → Tauri. İdempotent (meta bayrağı).
    fn migrate_if_needed(&mut self, candidates: &[PathBuf], report: &mut InitReport) -> Result<(), String> {
        let conn = self.conn.as_ref().unwrap();
        let done: Option<String> = conn
            .query_row("SELECT value FROM meta WHERE key='migration_done'", [], |r| r.get(0))
            .ok();
        if done.is_some() {
            return Ok(());
        }
        let row_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM kv", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;

        let mut source_desc = String::from("yok (temiz kurulum)");
        if row_count == 0 {
            let snap_root = self.dir.join("migration").join(stamp());
            if let Some(src) = find_electron_source(candidates, &snap_root, &self.dir)? {
                // 1) Taşıma ÖNCESİ tam JSON yedek
                let backups = self.dir.join("backups");
                fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
                let bj = serde_json::to_vec(&src.data).map_err(|e| e.to_string())?;
                atomic_write(&backups.join(format!("electron-gecis-yedek-{}.json", stamp())), &bj)
                    .map_err(|e| format!("Geçiş yedeği yazılamadı: {e}"))?;

                // 2) Tek transaction içinde taşı
                let now = now_iso();
                let conn = self.conn.as_mut().unwrap();
                let tx = conn.transaction().map_err(|e| e.to_string())?;
                {
                    let mut ins = tx
                        .prepare("INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)")
                        .map_err(|e| e.to_string())?;
                    for (k, v) in &src.data {
                        ins.execute(params![k, v, now]).map_err(|e| e.to_string())?;
                    }
                }
                tx.commit().map_err(|e| e.to_string())?;

                // 3) Doğrulama: sayı + her değer birebir
                let conn = self.conn.as_ref().unwrap();
                let fail = |msg: String| -> String {
                    let _ = conn.execute("DELETE FROM kv", []);
                    msg
                };
                let n: i64 = conn.query_row("SELECT COUNT(*) FROM kv", [], |r| r.get(0)).map_err(|e| e.to_string())?;
                if n as usize != src.data.len() {
                    return Err(fail(format!("Geçiş doğrulaması başarısız: satır sayısı uyuşmuyor ({n} ≠ {})", src.data.len())));
                }
                let mut sel = conn.prepare("SELECT value FROM kv WHERE key=?1").map_err(|e| e.to_string())?;
                for (k, v) in &src.data {
                    let got: Option<String> = sel.query_row([k], |r| r.get(0)).ok();
                    if got.as_deref() != Some(v.as_str()) {
                        drop(sel);
                        return Err(fail(format!("Geçiş doğrulaması başarısız: \"{k}\" değeri uyuşmuyor")));
                    }
                }
                log_line(&self.dir, &format!("GEÇİŞ TAMAM: {} anahtar {} → Tauri", src.data.len(), src.desc));
                report.migrated_from = Some(src.desc.clone());
                report.migrated_keys = src.data.len();
                source_desc = src.desc;
            }
        }
        let conn = self.conn.as_ref().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('migration_done', ?1)",
            params![format!("{} | kaynak: {}", now_iso(), source_desc)],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn persist_json(&self) -> std::io::Result<()> {
        let json = serde_json::to_vec(&self.mem).map_err(std::io::Error::other)?;
        atomic_write(&self.json_path, &json)
    }

    pub fn engine(&self) -> &'static str {
        if self.conn.is_some() { "sqlite" } else { "json" }
    }

    /// Bir grup yazma/silmeyi TEK transaction içinde uygula.
    pub fn apply(&mut self, ops: &[Op]) -> Result<(), String> {
        if self.closed {
            return Err("Depo kapatıldı".into());
        }
        if let Some(conn) = self.conn.as_mut() {
            let now = now_iso();
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            {
                let mut set = tx
                    .prepare_cached(
                        "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3) \
                         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                    )
                    .map_err(|e| e.to_string())?;
                let mut del = tx.prepare_cached("DELETE FROM kv WHERE key=?1").map_err(|e| e.to_string())?;
                for o in ops {
                    match o.op.as_str() {
                        "set" => { set.execute(params![o.key, o.val.as_deref().unwrap_or(""), now]).map_err(|e| e.to_string())?; }
                        "del" => { del.execute(params![o.key]).map_err(|e| e.to_string())?; }
                        other => return Err(format!("Bilinmeyen işlem: {other}")),
                    }
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
            // Disk başarılı → belleği güncelle
            for o in ops {
                if o.op == "set" { self.mem.insert(o.key.clone(), o.val.clone().unwrap_or_default()); }
                else { self.mem.remove(&o.key); }
            }
            Ok(())
        } else {
            let backup = self.mem.clone();
            for o in ops {
                if o.op == "set" { self.mem.insert(o.key.clone(), o.val.clone().unwrap_or_default()); }
                else { self.mem.remove(&o.key); }
            }
            if let Err(e) = self.persist_json() {
                self.mem = backup;
                return Err(e.to_string());
            }
            Ok(())
        }
    }

    /// Acil durum aynası: koc-data.json'u güncel tut (yalnızca SQLite modunda
    /// ve bellekte gerçek veri varken — boş veriyle asla ezme).
    pub fn refresh_mirror(&self) {
        if self.conn.is_none() || !self.mem.contains_key("koc-prods") {
            return;
        }
        if let Err(e) = self.persist_json() {
            log_line(&self.dir, &format!("Acil durum aynası güncellenemedi: {e}"));
        }
    }

    /// Düzgün kapanış: aynayı tazele, WAL'ı ana dosyaya işle, bağlantıyı kapat.
    pub fn shutdown(&mut self) {
        if self.closed {
            return;
        }
        self.refresh_mirror();
        if let Some(conn) = self.conn.take() {
            let _ = conn.pragma_update(None, "wal_checkpoint", "TRUNCATE");
            let _ = conn.close();
        }
        self.closed = true;
        log_line(&self.dir, "Depo düzgün kapatıldı.");
    }
}

/// GÜNLÜK OTOMATİK YEDEK: backups\gunluk-yedek-YYYY-MM-DD.json (son 7 gün).
pub fn daily_backup(dir: &Path, snapshot: &Kv) -> Result<Option<PathBuf>, String> {
    let backups = dir.join("backups");
    fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let target = backups.join(format!("gunluk-yedek-{today}.json"));
    let mut written = None;
    if !target.exists() && snapshot.contains_key("koc-prods") {
        let json = serde_json::to_vec(snapshot).map_err(|e| e.to_string())?;
        atomic_write(&target, &json).map_err(|e| e.to_string())?;
        written = Some(target);
    }
    let mut files: Vec<String> = fs::read_dir(&backups)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().to_string()))
        .filter(|f| f.starts_with("gunluk-yedek-") && f.ends_with(".json") && f.len() == "gunluk-yedek-0000-00-00.json".len())
        .collect();
    files.sort();
    if files.len() > 7 {
        for f in &files[..files.len() - 7] {
            let _ = fs::remove_file(backups.join(f));
        }
    }
    Ok(written)
}
