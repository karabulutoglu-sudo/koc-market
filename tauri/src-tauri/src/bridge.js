// ═══════════════════════════════════════════════════════════════════
// KOÇ MARKET — Tauri köprüsü (Electron preload.js'in karşılığı)
// index.html'in beklediği API'ler BİREBİR: window.kocStore, window.kocDB,
// window.kocFile. index.html'de hiçbir değişiklik gerekmez.
//
// OKUMA : Senkron, bellekten (açılışta Rust tüm veriyi sayfaya gömer).
// YAZMA : Bellek anında güncellenir + sıralı kuyrukla diske (SQLite
//         transaction). Aynı anahtara art arda yazmalar birleştirilir.
//         Hata olursa kırmızı uyarı çıkar ve otomatik tekrar denenir.
// KAPANIŞ: Pencere kapatılınca kuyruk boşalmadan uygulama kapanmaz.
// ═══════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  if (window.kocStore && window.kocStore.__tauri) return; // iki kez yüklenmesin

  var boot = window.__KOC_BOOT__ || { data: {}, engine: '?' };
  try { delete window.__KOC_BOOT__; } catch (e) { window.__KOC_BOOT__ = undefined; }

  var mem = new Map();
  Object.keys(boot.data || {}).forEach(function (k) { mem.set(k, String(boot.data[k])); });

  function invoke(cmd, args) {
    return window.__TAURI_INTERNALS__.invoke(cmd, args || {});
  }

  // ── Sıralı yazma kuyruğu ─────────────────────────────────────────
  var pending = new Map();   // anahtar → {op, val}  (en son değer kazanır)
  var running = false;
  var failCount = 0;
  var idleWaiters = [];

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function schedule() {
    if (!running) pump();
  }

  async function pump() {
    running = true;
    while (pending.size) {
      var batch = Array.from(pending.entries());
      pending.clear();
      try {
        await invoke('kv_apply', {
          ops: batch.map(function (e) { return { key: e[0], op: e[1].op, val: e[1].op === 'set' ? e[1].val : null }; })
        });
        if (failCount) { failCount = 0; showError(null); }
      } catch (err) {
        failCount++;
        // Başarısız grubu geri koy — bu arada daha yeni değer geldiyse o kazanır.
        batch.forEach(function (e) { if (!pending.has(e[0])) pending.set(e[0], e[1]); });
        console.error('[KOC] Diske yazma hatası:', err);
        showError('KAYIT HATASI: Son değişiklikler diske yazılamadı. Tekrar deneniyor... (' + failCount + ')\n' + err);
        await sleep(Math.min(5000, 500 * failCount));
      }
    }
    running = false;
    var w = idleWaiters; idleWaiters = [];
    w.forEach(function (fn) { fn(); });
  }

  function enqueue(key, op, val) {
    pending.set(key, { op: op, val: val });
    schedule();
  }

  // Kuyruk tamamen boşalana kadar bekle (en fazla timeoutMs)
  function drain(timeoutMs) {
    if (!running && !pending.size) return Promise.resolve(true);
    return new Promise(function (resolve) {
      var done = false;
      idleWaiters.push(function () { if (!done) { done = true; resolve(true); } });
      setTimeout(function () { if (!done) { done = true; resolve(false); } }, timeoutMs || 7000);
    });
  }

  // ── Kırmızı hata şeridi ─────────────────────────────────────────
  var errBox = null;
  function showError(msg) {
    if (!msg) { if (errBox) { errBox.remove(); errBox = null; } return; }
    var put = function () {
      if (!errBox) {
        errBox = document.createElement('div');
        errBox.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;background:#b00020;color:#fff;' +
          'font:bold 15px/1.4 Segoe UI,Arial,sans-serif;padding:10px 16px;white-space:pre-wrap;box-shadow:0 2px 8px rgba(0,0,0,.4)';
        document.body.appendChild(errBox);
      }
      errBox.textContent = '⚠ ' + msg;
    };
    if (document.body) put(); else document.addEventListener('DOMContentLoaded', put);
  }

  function toast(msg, color) {
    var put = function () {
      var t = document.createElement('div');
      t.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;max-width:420px;background:' + color +
        ';color:#fff;font:14px/1.45 Segoe UI,Arial,sans-serif;padding:12px 16px;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.35);cursor:pointer;white-space:pre-wrap';
      t.textContent = msg;
      t.onclick = function () { t.remove(); };
      document.body.appendChild(t);
      setTimeout(function () { t.remove(); }, 12000);
    };
    if (document.body) put(); else document.addEventListener('DOMContentLoaded', put);
  }

  // ── window.kocStore (index.html'in kullandığı) ───────────────────
  var kocStore = {
    read: function (key) { key = String(key); return mem.has(key) ? mem.get(key) : null; },
    write: function (key, val) { key = String(key); val = String(val); mem.set(key, val); enqueue(key, 'set', val); return true; },
    remove: function (key) { key = String(key); mem.delete(key); enqueue(key, 'del', null); return true; },
    keys: function () { return Array.from(mem.keys()); }
  };
  Object.defineProperty(kocStore, '__tauri', { value: true });

  // ── window.kocDB (aynı depo, yeni API) ───────────────────────────
  var kocDB = {
    get: function (key) { return kocStore.read(key); },
    set: function (key, val) { return kocStore.write(key, val); },
    delete: function (key) { return kocStore.remove(key); },
    getAll: function () { var o = {}; mem.forEach(function (v, k) { o[k] = v; }); return o; }
  };

  // ── window.kocFile (gerçek Kaydet / Aç pencereleri) ──────────────
  var kocFile = {
    save: function (defaultName, contents) {
      return invoke('file_save', { defaultName: String(defaultName || ''), contents: String(contents) });
    },
    open: function () { return invoke('file_open'); }
  };

  window.kocStore = Object.freeze(kocStore);
  window.kocDB = Object.freeze(kocDB);
  window.kocFile = Object.freeze(kocFile);

  // Tanı / bakım için
  window.kocApp = Object.freeze({
    platform: 'tauri',
    engine: boot.engine,
    info: function () { return invoke('kv_info'); },
    pendingWrites: function () { return pending.size + (running ? 1 : 0); },
    flush: function () { return drain(15000); }
  });

  // ── Kapanış ve yenileme: önce kuyruk boşalsın ────────────────────
  window.__kocFlushAndClose = async function () {
    await drain(7000);
    invoke('flush_done');
  };
  window.__kocReload = async function () {
    await drain(7000);
    location.reload();
  };

  // F5 / Ctrl+R ile kontrolsüz yenilemeyi engelle (veri kuyruğu kaybolmasın)
  window.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k === 'F5' || ((e.ctrlKey || e.metaKey) && (k === 'r' || k === 'R'))) {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey || e.ctrlKey) window.__kocReload();
    }
  }, true);

  // Sağ tık menüsü (Geri/Yenile/İncele) yalnızca yazı alanlarında açık kalsın
  window.addEventListener('contextmenu', function (e) {
    var t = e.target;
    var editable = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (!editable) e.preventDefault();
  }, true);

  // ── Açılış bildirimi ─────────────────────────────────────────────
  var rep = boot.report || {};
  if (rep.migrated_from && !mem.has('koc-tauri-gecis-bildirildi')) {
    toast('✅ Electron sürümündeki verileriniz yeni uygulamaya taşındı (' + rep.migrated_keys +
      ' kayıt).\nEski veriler silinmedi, yedek olarak duruyor.', '#1b7f3b');
    kocStore.write('koc-tauri-gecis-bildirildi', new Date().toISOString());
  }
  if (rep.warnings && rep.warnings.length) {
    toast('⚠ ' + rep.warnings.join('\n'), '#b26a00');
  }
})();
