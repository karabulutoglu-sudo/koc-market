// ═══════════════════════════════════════════════════════════════════
// KOÇ MARKET — Tauri ana süreç
// Electron main.js + preload.js'in karşılığı. index.html'ye DOKUNULMAZ:
// aynı window.kocStore / window.kocDB / window.kocFile köprüleri sağlanır.
// ═══════════════════════════════════════════════════════════════════

mod store;
mod bootstrap;
mod encoding_repair;

use serde_json::{json, Value};
use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use store::{log_line, InitReport, Op, Store};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
#[cfg(not(debug_assertions))]
use tauri_plugin_dialog::MessageDialogButtons;

struct AppState {
    store: Mutex<Option<Store>>,
    report: Mutex<InitReport>,
    flush_started: AtomicBool,
    encoding_repair: Mutex<Option<PendingEncodingRepair>>,
    #[cfg(not(debug_assertions))]
    pending_update: Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>,
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
    let repair = state.encoding_repair.lock().map_err(|_| "Onarım kilidi bozuk".to_string())?;
    if repair.is_some() {
        return Err("Onarım önizlemesi açık. Önce onarımı tamamlayın veya iptal edin.".into());
    }
    let mut guard = state.store.lock().map_err(|_| "Depo kilidi bozuk".to_string())?;
    let st = guard.as_mut().ok_or("Depo hazır değil")?;
    st.apply(&ops).map_err(|e| {
        log_line(&st.dir, &format!("Yazma hatası ({} işlem): {e}", ops.len()));
        e
    })
}

/// Güncel veriyi yedekle; düzeltilecek metinleri yalnızca önizlemede göster.
#[tauri::command(async)]
fn encoding_repair_preview(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let mut pending = state.encoding_repair.lock().map_err(|_| "Onarım kilidi bozuk".to_string())?;
    *pending = None;
    if state.flush_started.load(Ordering::SeqCst) {
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
    let mut pending = state.encoding_repair.lock().map_err(|_| "Onarım kilidi bozuk".to_string())?;
    if state.flush_started.load(Ordering::SeqCst) {
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
#[tauri::command]
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
    if let Ok(mut g) = state.store.lock() {
        if let Some(st) = g.as_mut() { st.ack_electron(); }
    }
    if let Ok(mut r) = state.report.lock() { r.electron_used = None; }
}

/// JS yazma kuyruğu boşaldı → depoyu kapat ve çık (ya da güncellemeyi kur).
#[tauri::command]
fn flush_done(app: AppHandle) {
    finish_and_exit(&app);
}

// ── Yalnızca geliştirme (debug) derlemesinde: otomatik test kancaları ──
#[tauri::command]
fn test_log(app: AppHandle, msg: String) {
    if cfg!(debug_assertions) {
        if msg == "pencere-basligi" {
            let t = app.get_webview_window("main").and_then(|w| w.title().ok()).unwrap_or_default();
            println!("[TEST] pencere başlığı = {t}");
        } else { println!("[TEST] {msg}"); }
    }
}

#[tauri::command]
fn test_close(app: AppHandle) {
    if cfg!(debug_assertions) {
        if let Some(w) = app.get_webview_window("main") { let _ = w.close(); }
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

fn finish_and_exit(app: &AppHandle) {
    shutdown_store(app);
    #[cfg(not(debug_assertions))]
    {
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
    app.exit(0);
}

/// Kapanış isteği: önce JS'teki bekleyen yazmalar diske insin.
fn request_flush_and_exit(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.flush_started.swap(true, Ordering::SeqCst) {
        return;
    }
    let ran = app
        .get_webview_window("main")
        .map(|w| w.eval("window.__kocFlushAndClose ? window.__kocFlushAndClose() : window.__TAURI_INTERNALS__.invoke('flush_done')").is_ok())
        .unwrap_or(false);
    if !ran {
        finish_and_exit(app);
        return;
    }
    // Emniyet: JS 8 sn içinde cevap vermezse yine de düzgün kapat.
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(8));
        if let Ok(dir) = app2.path().app_data_dir() {
            log_line(&dir, "Kapanış: JS kuyruğu 8 sn'de boşalmadı, zorla kapatılıyor.");
        }
        finish_and_exit(&app2);
    });
}

// ── index.html'e açılış verisi + köprü enjeksiyonu ─────────────────

fn build_boot_script(app: &AppHandle) -> String {
    let state = app.state::<AppState>();
    let guard = state.store.lock().unwrap();
    let report = state.report.lock().unwrap().clone();
    let boot = match guard.as_ref() {
        Some(st) => json!({ "engine": st.engine(), "report": report, "data": &st.mem }),
        None => json!({ "engine": "kapalı", "report": report, "data": {} }),
    };
    bootstrap::build_boot_script(&boot.to_string())
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
            request_flush_and_exit(&app); // önce veriler diske, sonra kurulum
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
    let app = tauri::Builder::default()
        // Tek kopya: aynı veritabanına iki pencere yazmasın
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            store: Mutex::new(None),
            report: Mutex::new(InitReport::default()),
            flush_started: AtomicBool::new(false),
            encoding_repair: Mutex::new(None),
            #[cfg(not(debug_assertions))]
            pending_update: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![kv_apply, kv_info, file_save, file_open, flush_done, electron_ack, encoding_repair_preview, encoding_repair_apply, encoding_repair_cancel, test_log, test_close])
        .setup(|app| {
            let handle = app.handle().clone();
            let dir = std::env::var("KOC_DATA_DIR").map(PathBuf::from)
                .unwrap_or_else(|_| app.path().app_data_dir().expect("veri klasörü"));
            let cands = electron_candidates(&handle);

            match Store::init(dir.clone(), &cands) {
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
            let win_title = format!("Koç Market {}", app.package_info().version);
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(&win_title)
                .inner_size(1280.0, 800.0)
                .min_inner_size(900.0, 600.0)
                .maximized(true)
                .visible(true)
                .on_web_resource_request(move |req, resp| {
                    let path = req.uri().path();
                    if path == "/" || path == "/index.html" {
                        let boot = build_boot_script(&h2);
                        let body = bootstrap::inject_into_html(resp.body(), &boot);
                        *resp.body_mut() = Cow::Owned(body);
                        resp.headers_mut().insert("Content-Type", tauri::http::HeaderValue::from_static(bootstrap::HTML_CONTENT_TYPE));
                        resp.headers_mut().insert("Cache-Control", tauri::http::HeaderValue::from_static("no-store"));
                    }
                })
                .on_page_load(|w, payload| {
                    #[cfg(debug_assertions)]
                    if let tauri::webview::PageLoadEvent::Finished = payload.event() {
                        if let Ok(path) = std::env::var("KOC_TEST_JS") {
                            if let Ok(js) = std::fs::read_to_string(path) { let _ = w.eval(&js); }
                        }
                    }
                    let _ = (&w, &payload);
                })
                .build()?;

            let h3 = handle.clone();
            win.on_window_event(move |ev| {
                if let WindowEvent::CloseRequested { api, .. } = ev {
                    api.prevent_close();
                    request_flush_and_exit(&h3);
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
            setup_updater(&handle);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Koç Market başlatılamadı");

    app.run(|app, ev| {
        if let RunEvent::Exit = ev {
            shutdown_store(app);
        }
    });
}
