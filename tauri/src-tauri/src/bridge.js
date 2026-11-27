// ═══════════════════════════════════════════════════════════════════
// KOÇ MARKET — Tauri köprüsü (Electron preload.js'in karşılığı)
// index.html'in beklediği API'ler BİREBİR: window.kocStore, window.kocDB,
// window.kocFile. index.html'de hiçbir değişiklik gerekmez.
//
// OKUMA : Senkron, bellekten (açılışta Rust tüm veriyi sayfaya gömer).
// YAZMA : Olağan değişiklikler belleğe ve tekrar denenebilen sıraya alınır.
//         Satış/geri yükleme commit ile tek yerel işlemde diske iner.
//         Uygulama bu toplu değişiklikleri yalnızca disk onayından sonra görür.
// KAPANIŞ: Köprü yalnızca başarılı yazımdan sonra kapanışı onaylar.
// ═══════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  if (window.kocStore && window.kocStore.__tauri) return; // iki kez yüklenmesin

  var boot = window.__KOC_BOOT__ || { data: {}, engine: '?' };
  try { delete window.__KOC_BOOT__; } catch (e) { window.__KOC_BOOT__ = undefined; }

  var mem = new Map();
  Object.keys(boot.data || {}).forEach(function (k) { mem.set(k, String(boot.data[k])); });
  var persisted = new Map(mem);
  var repairActive = false;
  var activeCommit = null;
  var failedCommit = false;
  var transition = null;
  var commitMarker = 'koc-atomic-last-operation';

  function ensureWritable() {
    if (repairActive) throw new Error('Türkçe onarım önizlemesi açık. Önce onarımı tamamlayın veya iptal edin.');
    if (transition) throw new Error('Bekleyen kayıtlar kapanış veya yenileme için diske yazılıyor.');
    if (activeCommit) throw new Error('Toplu kayıt diske yazılıyor. Önce sonucunu bekleyin.');
  }

  function invoke(cmd, args) {
    return window.__TAURI_INTERNALS__.invoke(cmd, args || {});
  }

  function writeError(cause) {
    if (cause instanceof Error) return cause;
    var error = new Error(cause && typeof cause.message === 'string' ? cause.message : String(cause));
    if (cause && typeof cause.code === 'string') error.code = cause.code;
    return error;
  }

  function setCachedValue(cache, key, value) {
    if (value === null) cache.delete(key);
    else cache.set(key, value);
  }

  function markRetryResolved() {
    if (!failCount) return;
    failCount = 0;
    if (!failedCommit) showError(null);
  }

  function showDenied(error) {
    toast('⚠ KAYIT REDDEDİLDİ: Değişiklik diske yazılmadı.\n' + error.message, '#b00020');
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
        batch.forEach(function (e) { setCachedValue(persisted, e[0], e[1].val); });
        markRetryResolved();
      } catch (cause) {
        var error = writeError(cause);
        if (error.code === 'permission_denied') {
          // Yerel yetki kontrolü bütün grubu diskten önce reddetti.
          // Bu anahtarda başka bir yazma bekliyorsa onun iyimser değeri geçerli kalır.
          batch.forEach(function (e) {
            var key = e[0];
            if (!pending.has(key)) setCachedValue(mem, key, persisted.has(key) ? persisted.get(key) : null);
          });
          markRetryResolved();
          showDenied(error);
          continue;
        }
        failCount++;
        // Başarısız grubu geri koy — bu arada daha yeni değer geldiyse o kazanır.
        batch.forEach(function (e) { if (!pending.has(e[0])) pending.set(e[0], e[1]); });
        console.error('[KOC] Diske yazma hatası:', error);
        showError('KAYIT HATASI: Son değişiklikler diske yazılamadı. Tekrar deneniyor... (' + failCount + ')\n' + error.message);
        await sleep(Math.min(5000, 500 * failCount));
      }
    }
    running = false;
    notifyIdle();
  }

  function enqueue(key, op, val) {
    pending.set(key, { op: op, val: val });
    schedule();
  }

  function isIdle(includeCommit) {
    return !running && !pending.size && (!includeCommit || !activeCommit);
  }

  function notifyIdle() {
    idleWaiters.slice().forEach(function (w) {
      if (isIdle(w.includeCommit)) w.finish(true);
    });
  }

  // Toplu işlem sıradaki normal yazıları bekler. Çıkış her ikisini de bekler.
  function drain(timeoutMs, includeCommit) {
    if (includeCommit === undefined) includeCommit = true;
    if (isIdle(includeCommit)) return Promise.resolve(true);
    return new Promise(function (resolve) {
      var waiter = { includeCommit: includeCommit, finish: function (result) {
        var index = idleWaiters.indexOf(waiter);
        if (index === -1) return;
        idleWaiters.splice(index, 1);
        clearTimeout(timer);
        resolve(result);
      } };
      idleWaiters.push(waiter);
      var timer = setTimeout(function () { waiter.finish(false); }, timeoutMs);
    });
  }

  function commit(operationId, entries) {
    try {
      if (typeof operationId !== 'string' || !operationId.trim()) throw new Error('Geçerli işlem kimliği gerekli.');
      if (activeCommit && activeCommit.id === operationId) return activeCommit.promise;
      ensureWritable();
      if (mem.get(commitMarker) === operationId) return Promise.resolve({ alreadyCommitted: true });
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Geçerli kayıt grubu gerekli.');
      var ops = Object.entries(entries).map(function (pair) {
        var key = pair[0], val = pair[1];
        if (!key || key === commitMarker || (val !== null && typeof val !== 'string')) throw new Error('Kayıt grubu geçersiz.');
        return { key: key, op: val === null ? 'del' : 'set', val: val };
      });
      if (!ops.length) throw new Error('Kayıt grubu boş.');
      ops.push({ key: commitMarker, op: 'set', val: operationId });
      var operation = { id: operationId, promise: null };
      activeCommit = operation;
      operation.promise = (async function () {
        try {
          if (!await drain(15000, false)) throw new Error('Önceki kayıtlar henüz diske yazılmadı.');
          await invoke('kv_apply', { ops: ops });
          ops.forEach(function (op) {
            setCachedValue(persisted, op.key, op.val);
            setCachedValue(mem, op.key, op.val);
          });
          failedCommit = false;
          showError(null);
          return { alreadyCommitted: false };
        } catch (cause) {
          var error = writeError(cause);
          if (error.code === 'permission_denied') {
            showDenied(error);
          } else {
            failedCommit = true;
            showError('KAYIT HATASI: İşlem diske yazılamadı. Tekrar deneyin.\n' + error.message);
          }
          throw error;
        } finally {
          activeCommit = null;
          notifyIdle();
        }
      })();
      return operation.promise;
    } catch (error) {
      return Promise.reject(error);
    }
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
    write: function (key, val) { ensureWritable(); key = String(key); if (key === commitMarker) throw new Error('İşlem kimliği değiştirilemez.'); val = String(val); mem.set(key, val); enqueue(key, 'set', val); return true; },
    remove: function (key) { ensureWritable(); key = String(key); if (key === commitMarker) throw new Error('İşlem kimliği değiştirilemez.'); mem.delete(key); enqueue(key, 'del', null); return true; },
    keys: function () { return Array.from(mem.keys()); },
    commit: commit
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
  window.kocAdmin = Object.freeze({
    status: function () { return invoke('admin_status'); },
    lock: function () { return invoke('admin_lock'); },
    unlock: function (pin) { return invoke('admin_unlock', { pin: String(pin) }); },
    changePin: function (currentPin, newPin) {
      return invoke('admin_change_pin', { currentPin: String(currentPin), newPin: String(newPin) });
    }
  });

  // Tanı / bakım için
  window.kocApp = Object.freeze({
    platform: 'tauri',
    engine: boot.engine,
    info: function () { return invoke('kv_info'); },
    pendingWrites: function () { return pending.size + (running ? 1 : 0) + (activeCommit ? 1 : 0); },
    flush: function () { return drain(15000); },
    hasEncodingDamage: function () {
      return ['koc-prods', 'koc-sales', 'koc-held', 'koc-cari-state'].some(function (key) {
        return /[\u00c2\u00c3\u00c4\u00c5\u00e2\ufffd]/.test(mem.get(key) || '');
      });
    },
    previewEncodingRepair: async function () {
      if (repairActive) throw new Error('Onarım önizlemesi zaten açık. Önce kapatın.');
      if (transition || activeCommit || failedCommit) throw new Error('Önce bekleyen kayıt işlemini tamamlayın.');
      if ((typeof cart !== 'undefined' && cart && cart.length) || (typeof paying !== 'undefined' && paying)) {
        throw new Error('Önce açık satışı tamamlayın veya sepeti beklemeye alın.');
      }
      repairActive = true;
      try {
        if (!await drain(15000)) throw new Error('Bekleyen kayıtlar henüz diske yazılmadı. Tekrar deneyin.');
        return await invoke('encoding_repair_preview');
      } catch (error) {
        await invoke('encoding_repair_cancel');
        repairActive = false;
        throw error;
      }
    },
    applyEncodingRepair: function (token) {
      if (!repairActive) return Promise.reject(new Error('Önce onarım önizlemesini açın.'));
      // Yazma kilidi başarılı işlemden sonra da sayfa yenilenene kadar açık kalır.
      return invoke('encoding_repair_apply', { token: String(token || '') });
    },
    cancelEncodingRepair: async function () {
      await invoke('encoding_repair_cancel');
      repairActive = false;
    }
  });

  // ── Kapanış ve yenileme: önce kuyruk boşalsın ────────────────────
  async function finishTransition(kind, action, onBlocked) {
    if (transition || (kind === 'reload' && repairActive)) {
      if (onBlocked) await onBlocked('transition');
      return false;
    }
    transition = kind;
    var acceptedClose = false;
    var reason;
    try {
      var drained = await drain(7000);
      if (!drained || failedCommit) {
        reason = drained ? 'write_failed' : 'pending';
        showError(kind === 'close'
          ? 'KAYIT HATASI: Kapanış için bekleyen kayıtların disk onayı alınamadı.'
          : 'KAYIT HATASI: Bekleyen kayıtlar diske yazılmadığı için yenileme durduruldu. Tekrar deneyin.');
      } else {
        var accepted = await action();
        acceptedClose = kind === 'close' && accepted !== false;
        return accepted !== false;
      }
    } catch (error) {
      showError('KAYIT HATASI: Kapanış veya yenileme tamamlanamadı.\n' + error);
      reason = 'no_reply';
    } finally {
      if (!acceptedClose) transition = null;
    }
    if (onBlocked) await onBlocked(reason);
    return false;
  }

  window.__kocFlushAndClose = function (generation) {
    return finishTransition('close',
      function () { return invoke('flush_done', { generation: generation }); },
      function (reason) {
        return invoke('flush_blocked', { generation: generation, reason: reason }).catch(function (error) {
          showError('KAYIT HATASI: Kapanış engellendi.\n' + error);
        });
      });
  };
  window.__kocReload = function () {
    return finishTransition('reload', function () { location.reload(); });
  };

  // F5 / Ctrl+R ile kontrolsüz yenilemeyi engelle (veri kuyruğu kaybolmasın)
  window.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k === 'F5' || ((e.ctrlKey || e.metaKey) && (k === 'r' || k === 'R'))) {
      e.preventDefault();
      e.stopPropagation();
      if (!repairActive && (e.shiftKey || e.ctrlKey)) window.__kocReload();
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
  // ESKİ PROGRAM BEKÇİSİ: taşımadan sonra Electron kullanıldıysa kalıcı kırmızı uyarı
  if (rep.electron_used) {
    var eu = rep.electron_used;
    var put = function () {
      var box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483647;' +
        'width:min(560px,92vw);background:#fff;color:#222;border:4px solid #b00020;border-radius:14px;' +
        'box-shadow:0 10px 40px rgba(0,0,0,.5);font:15px/1.5 Segoe UI,Arial,sans-serif;padding:22px 24px';
      var lines = [
        'Eski Koç Market programı (Electron), yeni programa geçtikten SONRA açılmış ve verisi değişmiş.',
        '',
        'Son değişiklik: ' + eu.when,
        (eu.new_sales ? ('Eski programda yaklaşık ' + eu.new_sales + ' yeni satış yapılmış.') : ('Değişen veri alanı: ' + eu.changed_keys)),
        '',
        'Bu değişiklikler YENİ PROGRAMDA YOK. Eksik satışları buraya elle girin.',
        'Eski programı bir daha açmayın; görev çubuğunda eski simge varsa kaldırın.',
        eu.backup ? ('\nEski programın verisi yedeklendi:\n' + eu.backup) : ''
      ];
      box.innerHTML = '<div style="font-weight:700;font-size:19px;color:#b00020;margin-bottom:10px">⚠ ESKİ PROGRAM KULLANILMIŞ</div>';
      var p = document.createElement('div'); p.style.whiteSpace = 'pre-wrap'; p.textContent = lines.join('\n'); box.appendChild(p);
      var b = document.createElement('button');
      b.textContent = 'Anladım';
      b.style.cssText = 'margin-top:16px;width:100%;padding:12px;border:0;border-radius:10px;background:#b00020;color:#fff;font:bold 16px Segoe UI,Arial,sans-serif;cursor:pointer';
      b.onclick = function () { invoke('electron_ack').finally(function () { box.remove(); }); };
      box.appendChild(b);
      document.body.appendChild(box);
    };
    if (document.body) put(); else document.addEventListener('DOMContentLoaded', put);
  }
  if (rep.warnings && rep.warnings.length) {
    toast('⚠ ' + rep.warnings.join('\n'), '#b26a00');
  }
})();
