// ═══════════════════════════════════════════════════════════════════
// KOÇ MARKET — Tauri köprüsü (Electron preload.js'in karşılığı)
// index.html'in beklediği window.kocStore, window.kocDB ve window.kocFile API'leri.
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
  var commitQueue = [];
  var queuedCommits = new Map();
  var failedCommit = null;
  var transition = null;
  var commitMarker = 'koc-atomic-last-operation';
  var salesKey = 'koc-sales';
  var completedCommits = new Set(mem.has(commitMarker) ? [mem.get(commitMarker)] : []);

  function ensureWritable(ordinaryWrite) {
    if (repairActive) throw new Error('Türkçe onarım önizlemesi açık. Önce onarımı tamamlayın veya iptal edin.');
    if (transition) throw new Error('Bekleyen kayıtlar kapanış veya yenileme için diske yazılıyor.');
    if (ordinaryWrite && activeCommit && !activeCommit.dailyBackup) {
      throw new Error('Toplu kayıt diske yazılıyor. Önce sonucunu bekleyin.');
    }
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

  function cachedRaw(value) {
    if (value === undefined) return null;
    if (typeof value === 'string') return value;
    if (value.receipts.length) {
      var previous = value.raw.trim().slice(1, -1);
      value.raw = '[' + value.receipts.reverse().join(',') + (previous.trim() ? ',' + previous : '') + ']';
      value.receipts.length = 0;
    }
    return value.raw;
  }

  function cacheSale(receipt, raw, alreadyCommitted) {
    var previous = persisted.get(salesKey);
    if (alreadyCommitted && JSON.parse(cachedRaw(previous) || '[]').some(function (sale) {
      return sale && String(sale.id) === receipt.id;
    })) return;
    var cached = typeof previous === 'object' ? previous : { raw: previous || '[]', receipts: [] };
    cached.receipts.push(raw);
    persisted.set(salesKey, cached);
    if (!pending.has(salesKey)) mem.set(salesKey, cached);
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
    if (pending.size && !running && !(activeCommit && activeCommit.writing)) pump();
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
    return !running && !pending.size && (!includeCommit || !queuedCommits.size);
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
    return enqueueCommit(operationId, entries, null);
  }

  function commitSale(operationId, sale, entries) {
    if (sale === null) return Promise.reject(new Error('Geçerli fiş gerekli.'));
    return enqueueCommit(operationId, entries, sale);
  }

  function enqueueCommit(operationId, entries, sale) {
    try {
      if (typeof operationId !== 'string' || !operationId.trim()) throw new Error('Geçerli işlem kimliği gerekli.');
      var queued = queuedCommits.get(operationId);
      if (queued) return queued.promise;
      ensureWritable();
      if (completedCommits.has(operationId)) return Promise.resolve({ alreadyCommitted: true });
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Geçerli kayıt grubu gerekli.');
      var ops = Object.entries(entries).map(function (pair) {
        var key = pair[0], val = pair[1];
        if (!key || key === commitMarker || (val !== null && typeof val !== 'string')) throw new Error('Kayıt grubu geçersiz.');
        return { key: key, op: val === null ? 'del' : 'set', val: val };
      });
      if (!ops.length) throw new Error('Kayıt grubu boş.');
      if (sale !== null && (!sale || typeof sale !== 'object' || Array.isArray(sale) || sale.id !== operationId)) {
        throw new Error('Fiş ve işlem kimliği eşleşmeli.');
      }
      var dailyBackup = sale === null && ops.length === 2 && Object.hasOwn(entries, 'koc-backups') &&
        Object.hasOwn(entries, 'koc-last-auto-backup-date');
      ops.push({ key: commitMarker, op: 'set', val: operationId });
      var operation = { id: operationId, ops: ops, dailyBackup: dailyBackup, writing: false, previousFailure: failedCommit };
      if (sale !== null) {
        operation.saleRaw = JSON.stringify(sale);
        operation.sale = JSON.parse(operation.saleRaw);
      }
      operation.promise = new Promise(function (resolve, reject) {
        operation.resolve = resolve;
        operation.reject = reject;
      });
      queuedCommits.set(operationId, operation);
      commitQueue.push(operation);
      runNextCommit();
      return operation.promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async function runNextCommit() {
    if (activeCommit || !commitQueue.length) return;
    var operation = commitQueue.shift();
    activeCommit = operation;
    try {
      while (!isIdle(false)) {
        if (!await drain(15000, false)) throw new Error('Önceki kayıtlar henüz diske yazılmadı.');
      }
      operation.writing = true;
      var result = operation.sale
        ? await invoke('sale_append', { sale: operation.sale, ops: operation.ops })
        : await invoke('kv_apply', { ops: operation.ops });
      var alreadyCommitted = operation.sale && result?.alreadyCommitted === true;
      var acknowledged = alreadyCommitted ? Object.entries(result.values) : operation.ops.map(function (op) {
        return [op.key, op.val];
      });
      acknowledged.forEach(function (record) {
        var key = record[0], value = record[1];
        setCachedValue(persisted, key, value);
        // Yedek yazılırken kabul edilen olağan yazı, onaylanana dek önbellekte kalır.
        if (!pending.has(key)) setCachedValue(mem, key, value);
      });
      if (operation.sale) cacheSale(operation.sale, operation.saleRaw, alreadyCommitted);
      completedCommits.add(operation.id);
      // Yedek veya hatadan önce kuyruğa giren başka bir kayıt bu hatayı temizlemez.
      if (!operation.dailyBackup && (!failedCommit || failedCommit.id === operation.id ||
        failedCommit === operation.previousFailure)) {
        failedCommit = null;
        showError(null);
      }
      operation.resolve({ alreadyCommitted: Boolean(alreadyCommitted) });
    } catch (cause) {
      var error = writeError(cause);
      if (error.code === 'permission_denied') {
        showDenied(error);
      } else if (operation.dailyBackup) {
        toast('⚠ Günlük yedek diske yazılamadı. Sonraki kayıtta tekrar denenecek.\n' + error.message, '#b26a00');
      } else {
        failedCommit = { id: operation.id };
        showError('KAYIT HATASI: İşlem diske yazılamadı. Tekrar deneyin.\n' + error.message);
      }
      operation.reject(error);
    } finally {
      queuedCommits.delete(operation.id);
      activeCommit = null;
      schedule();
      runNextCommit();
      notifyIdle();
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
    read: function (key) { return cachedRaw(mem.get(String(key))); },
    write: function (key, val) { ensureWritable(true); key = String(key); if (key === commitMarker) throw new Error('İşlem kimliği değiştirilemez.'); val = String(val); mem.set(key, val); enqueue(key, 'set', val); return true; },
    remove: function (key) { ensureWritable(true); key = String(key); if (key === commitMarker) throw new Error('İşlem kimliği değiştirilemez.'); mem.delete(key); enqueue(key, 'del', null); return true; },
    keys: function () { return Array.from(mem.keys()); },
    commit: commit
  };
  if (boot.engine === 'sqlite' && boot.saleAppend === true) kocStore.commitSale = commitSale;
  Object.defineProperty(kocStore, '__tauri', { value: true });

  // ── window.kocDB (aynı depo, yeni API) ───────────────────────────
  var kocDB = {
    get: function (key) { return kocStore.read(key); },
    set: function (key, val) { return kocStore.write(key, val); },
    delete: function (key) { return kocStore.remove(key); },
    getAll: function () { var o = {}; mem.forEach(function (v, k) { o[k] = cachedRaw(v); }); return o; }
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
    pendingWrites: function () { return pending.size + (running ? 1 : 0) + queuedCommits.size; },
    flush: function () { return drain(15000); },
    hasEncodingDamage: function () {
      return ['koc-prods', 'koc-sales', 'koc-held', 'koc-cari-state'].some(function (key) {
        return /[\u00c2\u00c3\u00c4\u00c5\u00e2\ufffd]/.test(kocStore.read(key) || '');
      });
    },
    previewEncodingRepair: async function () {
      if (repairActive) throw new Error('Onarım önizlemesi zaten açık. Önce kapatın.');
      if (transition || queuedCommits.size || failedCommit) throw new Error('Önce bekleyen kayıt işlemini tamamlayın.');
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
  window.__kocCloseFailed = function () {
    if (transition === 'close') transition = null;
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
