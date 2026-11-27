// ═══════════════════════════════════════════════════════════════════
// KOÇ MARKET — Tauri ana süreç
// Electron main.js + preload.js'in karşılığı. index.html'ye DOKUNULMAZ:
// aynı window.kocStore / window.kocDB / window.kocFile köprüleri sağlanır.
// ═══════════════════════════════════════════════════════════════════

mod store;
mod bootstrap;
mod encoding_repair;
mod authorization;
mod isolated_profile;
mod shutdown;

use serde_json::{json, Value};
use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use shutdown::{Flush, Intent, Shutdown, WritePermit};
use store::{log_line, InitReport, Op, Store};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

struct AppState {
    admin: Mutex<authorization::AdminSession>,
    store: Mutex<Option<Store>>,
    report: Mutex<InitReport>,
    closing: Shutdown,
    isolated_profile: Option<PathBuf>,
    next_test_write_delay_ms: AtomicU64,
    encoding_repair: Mutex<Option<PendingEncodingRepair>>,
    #[cfg(not(debug_assertions))]
    pending_update: Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>,
}

impl AppState {
    fn begin_write(&self) -> Result<WritePermit<'_>, String> {
        self.closing.begin_write()
    }

    fn verify_profile(&self) -> Option<&std::path::Path> {
        if cfg!(any(debug_assertions, feature = "verify-build")) {
            self.isolated_profile.as_deref()
        } else {
            None
        }
    }
}

struct PendingEncodingRepair {
    snapshot: store::Kv,
    plan: encoding_repair::RepairPlan,
    backup: PathBuf,
    token: String,
}

static REPAIR_NONCE: AtomicU64 = AtomicU64::new(0);

// ── Komutlar (JS köprüsünün çağırdığı) ─────────────────────────────

/// Sıralı yazma kuyruğundan gelen grup işlemi tek transaction'da uygula.
#[tauri::command(async)]
fn kv_apply(state: tauri::State<'_, AppState>, ops: Vec<Op>) -> Result<(), String> {
    let _write = state.begin_write()?;
    let repair = state.encoding_repair.lock().map_err(|_| "Onarım kilidi bozuk".to_string())?;
    if repair.is_some() {
        return Err("Onarım önizlemesi açık. Önce onarımı tamamlayın veya iptal edin.".into());
    }
    let mut guard = state.store.lock().map_err(|_| "Depo kilidi bozuk".to_string())?;
    let st = guard.as_mut().ok_or("Depo hazır değil")?;
    if state.verify_profile().is_some() {
        let delay = state.next_test_write_delay_ms.swap(0, Ordering::SeqCst);
        if delay != 0 {
            std::thread::sleep(std::time::Duration::from_millis(delay));
        }
    }
    let admin = state.admin.lock().map_err(|_| "Yetki kilidi bozuk".to_string())?;
    authorization::authorize(&st.mem, &ops, admin.authenticated())?;
    let measure = state.verify_profile().is_some() &&
        ops.iter().any(|op| op.key == "koc-sales") &&
        ops.iter().any(|op| op.key == "koc-atomic-last-operation");
    let wal_len = || std::fs::metadata(st.dir.join("kocmarket.db-wal")).map_or(0, |meta| meta.len());
    let wal_before = if measure { wal_len() } else { 0 };
    let start = std::time::Instant::now();
    st.apply(&ops).map_err(|e| {
        log_line(&st.dir, &format!("Yazma hatası ({} işlem): {e}", ops.len()));
        e
    })?;
    if measure {
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        let logical_bytes: usize = ops.iter().filter_map(|op| op.val.as_ref()).map(String::len).sum();
        let wal_after = std::fs::metadata(st.dir.join("kocmarket.db-wal")).map_or(0, |meta| meta.len());
        let delta = i128::from(wal_after) - i128::from(wal_before);
        log_line(&st.dir, &format!("PROOF_SALE_WRITE elapsed_ms={elapsed:.3} logical_bytes={logical_bytes} wal_delta_bytes={delta}"));
    }
    Ok(())
}

#[tauri::command]
fn admin_status(state: tauri::State<'_, AppState>) -> Result<authorization::Status, String> {
    let admin = state.admin.lock().map_err(|_| "Yetki kilidi bozuk".to_string())?;
    Ok(admin.status(true))
}

#[tauri::command]
fn admin_lock(state: tauri::State<'_, AppState>) -> Result<authorization::Status, String> {
    let mut admin = state.admin.lock().map_err(|_| "Yetki kilidi bozuk".to_string())?;
    admin.lock();
    Ok(admin.status(true))
}

#[tauri::command(async)]
fn admin_unlock(state: tauri::State<'_, AppState>, pin: String) -> Result<authorization::Status, String> {
    let _write = state.begin_write()?;
    let repair = state.encoding_repair.lock().map_err(|_| "Onarım kilidi bozuk".to_string())?;
    if repair.is_some() { return Err("Onarım önizlemesini kapatın.".into()); }
    let mut storage = state.store.lock().map_err(|_| "Depo kilidi bozuk".to_string())?;
    let st = storage.as_mut().ok_or("Depo hazır değil")?;
    let mut admin = state.admin.lock().map_err(|_| "Yetki kilidi bozuk".to_string())?;
    let Some(check) = admin.check(&st.mem, &pin)? else { return Ok(admin.status(false)); };
    if !check.migration.is_empty() { st.apply(&check.migration)?; }
    admin.open();
    Ok(admin.status(true))
}

#[tauri::command(async)]
fn admin_change_pin(state: tauri::State<'_, AppState>, current_pin: String, new_pin: String) -> Result<authorization::Status, String> {
    if !authorization::valid_pin(&new_pin) { return Err("PIN dört haneli olmalı.".into()); }
    let _write = state.begin_write()?;
    let repair = state.encoding_repair.lock().map_err(|_| "Onarım kilidi bozuk".to_string())?;
    if repair.is_some() { return Err("Onarım önizlemesini kapatın.".into()); }
    let mut storage = state.store.lock().map_err(|_| "Depo kilidi bozuk".to_string())?;
    let st = storage.as_mut().ok_or("Depo hazır değil")?;
    let mut admin = state.admin.lock().map_err(|_| "Yetki kilidi bozuk".to_string())?;
    if admin.check(&st.mem, &current_pin)?.is_none() { return Ok(admin.status(false)); }
    st.apply(&authorization::pin_ops(&new_pin)?)?;
    admin.lock();
    Ok(admin.status(true))
}

/// Güncel veriyi yedekle; düzeltilecek metinleri yalnızca önizlemede göster.
#[tauri::command(async)]
fn encoding_repair_preview(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let mut pending = state.encoding_repair.lock().map_err(|_| "Onarım kilidi bozuk".to_string())?;
    *pending = None;
    if state.closing.active() {
        return Err("Uygulama kapanıyor. Onarım için tekrar açın.".into());
    }
    let guard = state.store.lock().map_err(|_| "Depo kilidi bozuk".to_string())?;
    let st = guard.as_ref().ok_or("Depo hazır değil")?;
    let plan = encoding_repair::plan(&st.mem)?;
    let backup = st.repair_backup()?;
    let snapshot = st.mem.clone();
    let token = format!("{}-{}", chrono::Utc::now().timestamp_micros(), REPAIR_NONCE.fetch_add(1, Ordering::SeqCst));
    let mut preview = serde_json::to_value(&plan.preview).map_err(|e| e.to_string())?;
    preview["token"] = json!(token);
    preview["backup_path"] = json!(backup.display().to_string());
    log_line(&st.dir, &format!("Türkçe onarım önizlemesi: {} metin, {} incelenecek; tam yedek: {}", plan.preview.changes, plan.preview.unresolved, backup.display()));
    *pending = Some(PendingEncodingRepair { snapshot, plan, backup, token });
    Ok(preview)
}

/// İstemci yeni veri gönderemez; sadece gösterilmiş, yedeklenmiş plana onay verir.
#[tauri::command(async)]
fn encoding_repair_apply(state: tauri::State<'_, AppState>, token: String) -> Result<Value, String> {
    let _write = state.begin_write()?;
    let mut pending = state.encoding_repair.lock().map_err(|_| "Onarım kilidi bozuk".to_string())?;
    if state.closing.active() {
        return Err("Uygulama kapanıyor. Onarım uygulanmadı.".into());
    }
    let shown = pending.as_ref().ok_or("Önce onarım önizlemesini açın.")?;
    if token != shown.token {
        return Err("Önizleme artık geçerli değil. Yeniden önizleme oluşturun.".into());
    }
    if shown.plan.after.is_empty() {
        return Err("Onarılacak metin bulunamadı.".into());
    }
    let mut guard = state.store.lock().map_err(|_| "Depo kilidi bozuk".to_string())?;
    let st = guard.as_mut().ok_or("Depo hazır değil")?;
    st.apply_repair(&shown.snapshot, &shown.plan.after, &shown.backup)?;
    let result = json!({ "changes": shown.plan.preview.changes, "backup_path": shown.backup.display().to_string(), "unresolved": shown.plan.preview.unresolved });
    log_line(&st.dir, &format!("Türkçe onarım tamamlandı: {} metin; yeni satışlar ve sayısal alanlar korundu.", shown.plan.preview.changes));
    *pending = None;
    Ok(result)
}

#[tauri::command]
fn encoding_repair_cancel(state: tauri::State<'_, AppState>) -> Result<(), String> {
    *state.encoding_repair.lock().map_err(|_| "Onarım kilidi bozuk".to_string())? = None;
    Ok(())
}

/// Tanı bilgisi (Ayarlar ekranı veya konsol için): motor, klasör, geçiş.
#[tauri::command(async)]
fn kv_info(state: tauri::State<'_, AppState>) -> Value {
    let guard = state.store.lock().unwrap();
    let report = state.report.lock().unwrap().clone();
    match guard.as_ref() {
        Some(st) => json!({ "engine": st.engine(), "dir": st.dir, "keys": st.mem.len(), "report": report }),
        None => json!({ "engine": "kapalı" }),
    }
}

/// "Farklı Kaydet" penceresi → {ok,path} | {canceled} | {ok:false,error}
#[tauri::command(async)]
fn file_save(app: AppHandle, default_name: String, contents: String) -> Value {
    let mut b = app
        .dialog()
        .file()
        .set_title("Yedeği Kaydet")
        .set_file_name(if default_name.is_empty() { "koc-yedek.json".to_string() } else { default_name })
        .add_filter("Yedek Dosyaları", &["json", "csv"])
        .add_filter("Tüm Dosyalar", &["*"]);
    if let Ok(desk) = app.path().desktop_dir() {
        b = b.set_directory(desk);
    }
    if let Some(w) = app.get_webview_window("main") {
        b = b.set_parent(&w);
    }
    match b.blocking_save_file() {
        None => json!({ "canceled": true }),
        Some(fp) => match fp.into_path() {
            Ok(p) => match std::fs::write(&p, contents.as_bytes()) {
                Ok(_) => json!({ "ok": true, "path": p }),
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            },
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        },
    }
}

/// "Aç" penceresi → {ok,contents,path} | {canceled} | {ok:false,error}
#[tauri::command(async)]
fn file_open(app: AppHandle) -> Value {
    let mut b = app
        .dialog()
        .file()
        .set_title("Yedek Dosyası Seç")
        .add_filter("Yedek Dosyaları", &["json", "csv"])
        .add_filter("Tüm Dosyalar", &["*"]);
    if let Some(w) = app.get_webview_window("main") {
        b = b.set_parent(&w);
    }
    match b.blocking_pick_file() {
        None => json!({ "canceled": true }),
        Some(fp) => match fp.into_path() {
            Ok(p) => match std::fs::read(&p) {
                Ok(bytes) => {
                    // UTF-8 BOM'u temizle (Excel CSV'leri)
                    let s = String::from_utf8_lossy(&bytes);
                    let s = s.strip_prefix('\u{feff}').unwrap_or(&s).to_string();
                    json!({ "ok": true, "contents": s, "path": p })
                }
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            },
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        },
    }
}

/// "Eski program kullanılmış" uyarısında "Anladım" → yeni durumu taban kabul et.
#[tauri::command]
fn electron_ack(state: tauri::State<'_, AppState>) {
    let Ok(_write) = state.begin_write() else { return; };
    if let Ok(mut g) = state.store.lock() {
        if let Some(st) = g.as_mut() { st.ack_electron(); }
    }
    if let Ok(mut r) = state.report.lock() { r.electron_used = None; }
}

/// JS yazma kuyruğu boşaldı → depoyu kapat ve çık (ya da güncellemeyi kur).
#[tauri::command]
fn flush_done(app: AppHandle, generation: u32) -> bool {
    match app.state::<AppState>().closing.acknowledge(generation) {
        Flush::Ready(intent) => {
            // Kurulum ve depo kapatma ana olay döngüsünü engellemesin.
            std::thread::spawn(move || finish_and_exit(&app, intent));
            true
        }
        Flush::Busy => {
            show_close_blocked(&app, generation, "native_write");
            false
        }
        Flush::Stale => false,
    }
}

#[tauri::command]
fn flush_blocked(app: AppHandle, generation: u32, reason: String) {
    show_close_blocked(&app, generation, &reason);
}

// ── Yalnızca geliştirme (debug) derlemesinde: otomatik test kancaları ──
#[tauri::command]
fn test_log(app: AppHandle, msg: String) {
    if let Some(profile) = app.state::<AppState>().verify_profile() {
        if msg == "pencere-basligi" {
            let t = app.get_webview_window("main").and_then(|w| w.title().ok()).unwrap_or_default();
            println!("[TEST] pencere başlığı = {t}");
        } else {
            use std::io::Write;
            let logs = profile.join("logs");
            if std::fs::create_dir_all(&logs).is_ok() {
                if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true)
                    .open(logs.join("webview-proof.log"))
                {
                    let _ = writeln!(file, "{msg}");
                }
            }
            println!("[TEST] {msg}");
        }
    }
}

#[tauri::command]
fn test_close(app: AppHandle) {
    if app.state::<AppState>().verify_profile().is_some() {
        if let Some(w) = app.get_webview_window("main") { let _ = w.close(); }
    }
}

#[tauri::command]
fn test_delay_next_write(state: tauri::State<'_, AppState>, ms: u64) {
    if state.verify_profile().is_some() {
        state.next_test_write_delay_ms.store(ms.min(15_000), Ordering::SeqCst);
    }
}

fn shutdown_store(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut g) = state.store.lock() {
            if let Some(st) = g.as_mut() {
                st.shutdown();
            }
        }
    }
}

fn finish_and_exit(app: &AppHandle, intent: Intent) {
    shutdown_store(app);
    #[cfg(not(debug_assertions))]
    if intent == Intent::Update {
        let state = app.state::<AppState>();
        let pending = state.pending_update.lock().unwrap().take();
        if let Some((update, bytes)) = pending {
            // Windows'ta install() kurulum programını başlatır ve süreci sonlandırır.
            if let Err(e) = update.install(bytes) {
                if let Ok(dir) = app.path().app_data_dir() {
                    log_line(&dir, &format!("Güncelleme kurulamadı: {e}"));
                }
            } else {
                app.restart();
            }
        }
    }
    #[cfg(debug_assertions)]
    let _ = intent;
    app.exit(0);
}

/// Deneme kimliği eski kuyruk yanıtının yeni kapanışa izin vermesini önler.
fn request_flush_and_exit(app: &AppHandle, intent: Intent) -> bool {
    let Some(generation) = app.state::<AppState>().closing.start(intent) else { return false; };
    let ran = app
        .get_webview_window("main")
        .map(|w| w.eval(format!("window.__kocFlushAndClose && window.__kocFlushAndClose({generation})")).is_ok())
        .unwrap_or(false);
    if !ran {
        show_close_blocked(app, generation, "no_reply");
        return true;
    }
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(9));
        show_close_blocked(&app2, generation, "no_reply");
    });
    true
}

fn show_close_blocked(app: &AppHandle, generation: u32, reason: &str) {
    let Some(intent) = app.state::<AppState>().closing.begin_prompt(generation) else { return; };
    let explanation = match reason {
        "pending" | "native_write" => "Bir disk yazımı hâlâ sürüyor.",
        "write_failed" => "Son kayıt başarısız oldu. Kasaya dönerek işlemi yeniden deneyebilirsiniz.",
        _ => "Kasa ekranından disk onayı alınamadı.",
    };
    let retry_after_wait = reason != "write_failed";
    let retry = if retry_after_wait { "Bekle ve Tekrar Dene" } else { "Kasaya Dön ve Yeniden Dene" };
    const FORCE: &str = "Yine de Kapat";
    const STAY: &str = "Vazgeç";
    let (details, buttons) = match intent {
        Intent::Close => (
            "Şimdi kapatırsanız bekleyen son işlem kaybolabilir.",
            MessageDialogButtons::YesNoCancelCustom(retry.into(), FORCE.into(), STAY.into()),
        ),
        Intent::Update => (
            "Güncelleme, kayıtlar doğrulanıncaya kadar kurulmayacak.",
            MessageDialogButtons::OkCancelCustom(retry.into(), STAY.into()),
        ),
    };
    let mut dialog = app.dialog()
        .message(format!("Son değişiklikler henüz diske yazılamadı.\n\n{explanation}\n{details}"))
        .title("Koç Market — Bekleyen Kayıt")
        .kind(MessageDialogKind::Warning)
        .buttons(buttons);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    let app = app.clone();
    dialog.show_with_result(move |answer| {
        let forced = answer == MessageDialogResult::Custom(FORCE.into()) && intent == Intent::Close;
        if app.state::<AppState>().closing.end_prompt(generation, forced).is_none() {
            return;
        }
        if forced {
            // Devam eden yerel işlemin atomik disk yazımı bitene dek bekler.
            std::thread::spawn(move || finish_and_exit(&app, Intent::Close));
        } else if retry_after_wait && answer == MessageDialogResult::Custom(retry.into()) {
            request_flush_and_exit(&app, intent);
        } else if intent == Intent::Update {
            #[cfg(not(debug_assertions))]
            if let Ok(mut pending) = app.state::<AppState>().pending_update.lock() {
                pending.take();
            }
        }
    });
}

// ── index.html'e açılış verisi + köprü enjeksiyonu ─────────────────

fn build_boot_script(app: &AppHandle, nonce: &str) -> String {
    let state = app.state::<AppState>();
    let guard = state.store.lock().unwrap();
    let report = state.report.lock().unwrap().clone();
    let boot = match guard.as_ref() {
        Some(st) => {
            let data: store::Kv = st.mem.iter().filter(|(key,_)| !authorization::pin_key(key))
                .map(|(key,value)| (key.clone(),value.clone())).collect();
            json!({ "engine": st.engine(), "report": report, "data": data })
        }
        None => json!({ "engine": "kapalı", "report": report, "data": {} }),
    };
    bootstrap::build_boot_script_with_nonce(&boot.to_string(), nonce)
}

// ── Electron veri klasörü adayları ─────────────────────────────────

fn electron_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = vec![];
    if let Ok(p) = app.path().data_dir() { roots.push(p); }     // Windows: %APPDATA%
    if let Ok(p) = app.path().config_dir() { roots.push(p); }   // Linux: ~/.config
    let mut out: Vec<PathBuf> = vec![];
    for r in roots {
        // Kurulu sürüm "Koç Market" (productName), geliştirme modu "koc-market"
        for name in ["Koç Market", "koc-market"] {
            let p = r.join(name);
            if !out.contains(&p) { out.push(p); }
        }
    }
    // Test/teşhis için: KOC_ELECTRON_DIR ortam değişkeni ile ek aday
    if let Ok(extra) = std::env::var("KOC_ELECTRON_DIR") {
        out.insert(0, PathBuf::from(extra));
    }
    out
}

// ── Güncelleme (yalnızca kurulu sürümde) ───────────────────────────

#[cfg(not(debug_assertions))]
fn setup_updater(app: &AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        let updater = match app.updater() { Ok(u) => u, Err(_) => return };
        let update = match updater.check().await { Ok(Some(u)) => u, _ => return };
        let bytes = match update.download(|_, _| {}, || {}).await { Ok(b) => b, Err(e) => {
            if let Ok(dir) = app.path().app_data_dir() { log_line(&dir, &format!("Güncelleme indirilemedi: {e}")); }
            return;
        }};
        let notes = format_notes(update.body.as_deref().unwrap_or(""));
        let version = update.version.clone();
        let app2 = app.clone();
        let yes = tauri::async_runtime::spawn_blocking(move || {
            app2.dialog()
                .message(format!("BU GÜNCELLEMEDE:\n\n{notes}\n\nŞimdi kurulup uygulama yeniden başlatılsın mı?"))
                .title(format!("Koç Market {version} güncellemesi hazır"))
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::OkCancelCustom("Güncellemeyi Kur".into(), "Daha Sonra".into()))
                .blocking_show()
        }).await.unwrap_or(false);
        if yes {
            *app.state::<AppState>().pending_update.lock().unwrap() = Some((update, bytes));
            if !request_flush_and_exit(&app, Intent::Update) {
                app.state::<AppState>().pending_update.lock().unwrap().take();
            }
        }
    });
}

#[cfg(not(debug_assertions))]
fn format_notes(raw: &str) -> String {
    let mut out = vec![];
    for line in raw.replace('\r', "").lines() {
        let l = line.trim_start_matches('#').trim();
        let l = if let Some(r) = l.strip_prefix("- ").or_else(|| l.strip_prefix("* ")) { format!("• {r}") } else { l.to_string() };
        out.push(l.replace("**", "").replace('`', ""));
    }
    let t = out.join("\n").trim().to_string();
    if t.is_empty() { "Bu sürüm için ayrıntılı güncelleme notu bulunmuyor.".into() } else { t }
}

// ── Uygulama ───────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let profile = match isolated_profile::requested() {
        Ok(profile) => profile,
        Err(error) => {
            eprintln!("Koç Market başlatılmadı: {error}");
            std::process::exit(2);
        }
    };
    let mut builder = tauri::Builder::default();
    if profile.is_none() {
        // Sınama ikilisi kurulu kasanın tek kopya kaydını kullanmaz.
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }))
            .plugin(tauri_plugin_updater::Builder::new().build());
    }
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            admin: Mutex::new(authorization::AdminSession::default()),
            store: Mutex::new(None),
            report: Mutex::new(InitReport::default()),
            closing: Shutdown::new(),
            isolated_profile: profile,
            next_test_write_delay_ms: AtomicU64::new(0),
            encoding_repair: Mutex::new(None),
            #[cfg(not(debug_assertions))]
            pending_update: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![kv_apply, kv_info, admin_unlock, admin_lock, admin_status, admin_change_pin, file_save, file_open, flush_done, flush_blocked, electron_ack, encoding_repair_preview, encoding_repair_apply, encoding_repair_cancel, test_log, test_close, test_delay_next_write])
        .setup(|app| {
            let handle = app.handle().clone();
            let profile = app.state::<AppState>().isolated_profile.clone();
            let (dir, cands) = match profile.as_ref() {
                Some(dir) => (dir.clone(), Vec::new()),
                None => (app.path().app_data_dir()?, electron_candidates(&handle)),
            };

            match Store::init(dir.clone(), &cands).and_then(|(mut store, report)| {
                let migrations = authorization::startup_migrations(
                    &store.mem, include_str!("../../../index.html"), chrono::Utc::now().timestamp_millis()
                )?;
                if !migrations.is_empty() { store.apply(&migrations)?; }
                store.synchronize_mirror()?;
                Ok((store, report))
            }) {
                Ok((st, report)) => {
                    let state = app.state::<AppState>();
                    *state.store.lock().unwrap() = Some(st);
                    *state.report.lock().unwrap() = report;
                }
                Err(e) => {
                    // Veri riski varsa AÇMA — Electron verisi olduğu gibi duruyor.
                    log_line(&dir, &format!("AÇILIŞ DURDURULDU: {e}"));
                    let h = handle.clone();
                    std::thread::spawn(move || {
                        h.dialog()
                            .message(format!(
                                "Veriler güvenli şekilde yüklenemedi, uygulama kapatılacak.\n\n{e}\n\n\
                                 Eski (Electron) verileriniz SİLİNMEDİ, olduğu gibi duruyor.\n\
                                 Günlük: {}\\logs", dir.display()))
                            .title("Koç Market — Açılış Durduruldu")
                            .kind(MessageDialogKind::Error)
                            .blocking_show();
                        h.exit(1);
                    });
                    return Ok(());
                }
            }

            // Pencere: index.html istendiğinde GÜNCEL veri + köprü enjekte edilir
            let h2 = handle.clone();
            // Başlıkta sürüm: eski (Electron) programla bir bakışta ayırt edilsin
            let label = if profile.is_some() { " — Sınama Profili" } else { "" };
            let win_title = format!("Koç Market {}{label}", app.package_info().version);
            let mut win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(&win_title)
                .inner_size(1280.0, 800.0)
                .min_inner_size(900.0, 600.0)
                .maximized(true)
                .visible(true)
                .on_web_resource_request(move |req, resp| {
                    let path = req.uri().path();
                    if path == "/" || path == "/index.html" {
                        let mut bytes = [0_u8; 16];
                        let nonce = if ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes).is_ok() {
                            use std::fmt::Write;
                            let mut value = String::with_capacity(32);
                            for byte in bytes { let _ = write!(value, "{byte:02x}"); }
                            value
                        } else {
                            String::new()
                        };
                        let boot = build_boot_script(&h2, &nonce);
                        let body = bootstrap::inject_into_html(resp.body(), &boot);
                        *resp.body_mut() = Cow::Owned(body);
                        resp.headers_mut().insert("Content-Type", tauri::http::HeaderValue::from_static(bootstrap::HTML_CONTENT_TYPE));
                        resp.headers_mut().insert("Cache-Control", tauri::http::HeaderValue::from_static("no-store"));
                        if let Some(tauri::utils::config::Csp::Policy(policy)) = &h2.config().app.security.csp {
                            let csp = bootstrap::csp_with_boot_nonce(policy, &nonce);
                            if let Ok(value) = tauri::http::HeaderValue::from_str(&csp) {
                                resp.headers_mut().insert("Content-Security-Policy", value);
                            }
                        }
                    }
                })
                .on_page_load(|w, payload| {
                    if let tauri::webview::PageLoadEvent::Finished = payload.event() {
                        // Sınama betiğini yalnızca izole uygulama sayfasında çalıştır.
                        let url = payload.url();
                        if url.path() == "/index.html" && (url.scheme() == "tauri"
                            || url.host_str() == Some("tauri.localhost"))
                        {
                            if let Some(profile) = w.state::<AppState>().verify_profile() {
                                if let Some(script) = isolated_profile::script(profile) {
                                    let _ = w.eval(&script);
                                }
                            }
                        }
                    }
                });
            if let Some(profile) = profile.as_ref() {
                win = win.data_directory(profile.join("webview"));
                if cfg!(any(debug_assertions, feature = "verify-build")) {
                    win = win.initialization_script(
                        "window.__KOC_VERIFY_CSP = []; document.addEventListener('securitypolicyviolation', event => window.__KOC_VERIFY_CSP.push(event.violatedDirective));"
                    );
                }
            }
            let win = win.build()?;

            let h3 = handle.clone();
            win.on_window_event(move |ev| {
                if let WindowEvent::CloseRequested { api, .. } = ev {
                    api.prevent_close();
                    request_flush_and_exit(&h3, Intent::Close);
                }
            });

            // Günlük yedek (arka planda, satışı bloklamaz)
            let h4 = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                let state = h4.state::<AppState>();
                let snap = { state.store.lock().unwrap().as_ref().map(|s| (s.dir.clone(), s.mem.clone())) };
                if let Some((dir, mem)) = snap {
                    match store::daily_backup(&dir, &mem) {
                        Ok(Some(p)) => log_line(&dir, &format!("Günlük yedek alındı: {}", p.display())),
                        Ok(None) => {}
                        Err(e) => log_line(&dir, &format!("Günlük yedek hatası: {e}")),
                    }
                    if let Some(st) = state.store.lock().unwrap().as_ref() { st.refresh_mirror(); }
                }
            });

            #[cfg(not(debug_assertions))]
            if profile.is_none() {
                setup_updater(&handle);
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Koç Market başlatılamadı");

    app.run(|app, ev| match ev {
        RunEvent::ExitRequested { code: None, api, .. } if app.get_webview_window("main").is_some() => {
            api.prevent_exit();
            request_flush_and_exit(app, Intent::Close);
        }
        RunEvent::Exit => shutdown_store(app),
        _ => {}
    });
}
