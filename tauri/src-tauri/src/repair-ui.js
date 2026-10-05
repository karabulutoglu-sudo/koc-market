(function () {
  'use strict';
  if (window.__kocRepairUiInstalled) return;
  window.__kocRepairUiInstalled = true;

  function install() {
    var api = window.kocApp;
    if (!api || typeof api.previewEncodingRepair !== 'function' ||
        typeof api.applyEncodingRepair !== 'function' || typeof api.cancelEncodingRepair !== 'function') return;

    var style = document.createElement('style');
    style.textContent = '#koc-encoding-launch{position:fixed;right:18px;bottom:18px;z-index:2147483645;min-height:48px;padding:12px 18px;border:2px solid #fff;border-radius:12px;background:#164e63;color:#fff;font:700 16px Segoe UI,Arial,sans-serif;box-shadow:0 3px 14px #0005;cursor:pointer}' +
      '#koc-encoding-launch.koc-encoding-attention{background:#9a3412;box-shadow:0 0 0 4px #fdba7477,0 3px 14px #0005}' +
      '#koc-encoding-overlay{position:fixed;inset:0;z-index:2147483647;background:#03121bd9;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}' +
      '#koc-encoding-dialog{width:min(900px,100%);max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;border-radius:16px;background:#fff;color:#172b3a;box-shadow:0 16px 64px #0009;padding:24px;font:16px/1.5 Segoe UI,Arial,sans-serif}' +
      '#koc-encoding-dialog h2{margin:0 0 12px;font-size:25px}' +
      '#koc-encoding-dialog p{margin:10px 0}' +
      '#koc-encoding-dialog .koc-encoding-status{background:#eff6ff;border-radius:10px;padding:12px;white-space:pre-wrap}' +
      '#koc-encoding-dialog .koc-encoding-error{background:#fff1f2;color:#9f1239}' +
      '#koc-encoding-dialog .koc-encoding-backup{font-size:14px;overflow-wrap:anywhere;background:#f1f5f9;border-radius:8px;padding:10px}' +
      '#koc-encoding-dialog .koc-encoding-table-wrap{overflow:auto;max-height:38vh;border:1px solid #dbe3eb;border-radius:8px;margin:12px 0}' +
      '#koc-encoding-dialog table{width:100%;border-collapse:collapse;text-align:left;font-size:14px}' +
      '#koc-encoding-dialog th,#koc-encoding-dialog td{padding:10px;border-bottom:1px solid #dbe3eb;white-space:pre-wrap;overflow-wrap:anywhere;vertical-align:top}' +
      '#koc-encoding-dialog th{background:#f1f5f9}' +
      '#koc-encoding-dialog .koc-encoding-actions{display:flex;gap:12px;flex-wrap:wrap;justify-content:flex-end;margin-top:18px}' +
      '#koc-encoding-dialog button{min-height:48px;border:0;border-radius:10px;padding:12px 20px;font:700 16px Segoe UI,Arial,sans-serif;cursor:pointer}' +
      '#koc-encoding-dialog button:disabled{opacity:.5;cursor:wait}' +
      '#koc-encoding-dialog button:focus-visible,#koc-encoding-launch:focus-visible{outline:3px solid #f59e0b;outline-offset:3px}' +
      '#koc-encoding-dialog .koc-encoding-confirm{background:#087f5b;color:#fff}' +
      '#koc-encoding-dialog .koc-encoding-cancel{background:#e2e8f0;color:#172b3a}' +
      '#koc-encoding-dialog .koc-encoding-retry{background:#164e63;color:#fff}' +
      '#koc-encoding-dialog .koc-encoding-spinner{display:inline-block;width:16px;height:16px;border:3px solid #9cc9e0;border-top-color:#164e63;border-radius:50%;margin-right:10px;vertical-align:middle;animation:koc-encoding-spin 1s linear infinite}' +
      '@keyframes koc-encoding-spin{to{transform:rotate(360deg)}}' +
      '@media(max-width:600px){#koc-encoding-dialog{padding:18px}#koc-encoding-dialog .koc-encoding-actions button{flex:1 1 100%}}';
    document.head.appendChild(style);

    function element(tag, text, className) {
      var node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    }

    var launch = element('button', 'Türkçe Adları Onar');
    launch.id = 'koc-encoding-launch';
    launch.type = 'button';
    try { if (typeof api.hasEncodingDamage === 'function' && api.hasEncodingDamage()) launch.className = 'koc-encoding-attention'; } catch (ignore) {}
    document.body.appendChild(launch);

    var overlay = null;
    var dialog, status, details, applyButton, cancelButton, retryButton;
    var stage = 'closed';
    var token = null;
    var currentRequest = null;
    var hiddenSiblings = [];
    var previousFocus = null;
    var cancelFailed = false;

    function setStatus(message, busy, error) {
      status.replaceChildren();
      status.className = 'koc-encoding-status' + (error ? ' koc-encoding-error' : '');
      if (busy) {
        var spinner = element('span', undefined, 'koc-encoding-spinner');
        spinner.setAttribute('aria-hidden', 'true');
        status.appendChild(spinner);
      }
      status.appendChild(element('span', message));
    }

    function setButtons() {
      applyButton.disabled = stage !== 'ready' || !token;
      cancelButton.disabled = stage === 'applying' || stage === 'cancelling' || stage === 'reload';
      retryButton.hidden = stage !== 'error' && stage !== 'reload';
      retryButton.disabled = false;
      retryButton.textContent = stage === 'reload' ? 'Uygulamayı Yenile' : 'Tekrar Dene';
    }

    function fail(error, cancelling) {
      token = null;
      stage = 'error';
      cancelFailed = !!cancelling;
      setStatus((cancelling ? 'Onarım ekranı kapatılamadı. Tekrar deneyin.' : 'İşlem tamamlanamadı. Onarım uygulanmadı.') +
        '\n' + String(error && error.message ? error.message : error), false, true);
      setButtons();
      retryButton.focus();
    }

    function validCount(value) {
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    }

    function renderPreview(preview) {
      if (!preview || !['changes', 'product_changes', 'sale_changes', 'other_changes', 'unresolved'].every(function (key) { return validCount(preview[key]); }) ||
          !Array.isArray(preview.samples) || typeof preview.backup_path !== 'string' || !preview.backup_path.trim() ||
          (preview.changes > 0 && (typeof preview.token !== 'string' || !preview.token))) {
        throw new Error('Yedek ve önizleme doğrulanamadı. Güvenli bir önizleme olmadan onarım başlatılamaz.');
      }
      token = preview.changes > 0 ? preview.token : null;
      details.replaceChildren();
      details.appendChild(element('p', 'Düzeltilecek metin: ' + preview.changes + '  |  Ürün yazısı: ' + preview.product_changes +
        '  |  Satış yazısı: ' + preview.sale_changes + '  |  Diğer yazılar: ' + preview.other_changes));
      details.appendChild(element('p', 'Onarım öncesi yedek oluşturuldu:\n' + preview.backup_path, 'koc-encoding-backup'));
      if (preview.unresolved) {
        details.appendChild(element('p', 'Kesin olarak çözülemeyen ' + preview.unresolved + ' metin bu işlemde aynen bırakılacak.'));
      }
      if (preview.samples.length) {
        details.appendChild(element('p', 'Önizlemeden örnekler:'));
        var wrap = element('div', undefined, 'koc-encoding-table-wrap');
        var table = element('table');
        var head = element('thead');
        var headers = element('tr');
        ['Kayıt', 'Şimdiki ad', 'Onarımdan sonra'].forEach(function (label) { headers.appendChild(element('th', label)); });
        head.appendChild(headers);
        table.appendChild(head);
        var body = element('tbody');
        preview.samples.forEach(function (sample) {
          var row = element('tr');
          var scope = { product: 'Ürün', products: 'Ürün', sale: 'Satış', sales: 'Satış', other: 'Diğer' }[sample.scope] || String(sample.scope || 'Metin');
          row.appendChild(element('td', scope + (sample.path ? '\n' + String(sample.path) : '')));
          row.appendChild(element('td', String(sample.before)));
          row.appendChild(element('td', String(sample.after)));
          body.appendChild(row);
        });
        table.appendChild(body);
        wrap.appendChild(table);
        details.appendChild(wrap);
      }
      details.appendChild(element('p', 'Satışlar korunur; fiyatlar, barkodlar, miktarlar ve tutarlar değişmez. Yalnızca doğrulanmış bozuk metinler düzeltilir.'));
      stage = 'ready';
      setStatus(preview.changes ? 'Önizlemeyi kontrol edin. Onarımı başlatmak için “Onar ve Yenile” düğmesine basın.' : 'Onarılacak kayıt bulunamadı.', false, false);
      setButtons();
      cancelButton.focus();
    }

    function preview(reset) {
      if (!overlay || stage === 'preview' || stage === 'applying' || stage === 'cancelling' || stage === 'reload') return;
      stage = 'preview';
      token = null;
      cancelFailed = false;
      details.replaceChildren();
      setStatus('Mevcut kayıtlar kontrol ediliyor ve onarım öncesi yedek alınıyor…', true, false);
      setButtons();
      currentRequest = (async function () {
        try {
          if (reset) await api.cancelEncodingRepair();
          var result = await api.previewEncodingRepair();
          if (overlay && stage === 'preview') renderPreview(result);
        } catch (error) {
          if (overlay && stage === 'preview') fail(error, false);
        }
      })();
    }

    function close() {
      overlay.remove();
      overlay = null;
      stage = 'closed';
      token = null;
      hiddenSiblings.forEach(function (item) {
        item.node.inert = item.inert;
        if (item.aria === null) item.node.removeAttribute('aria-hidden');
        else item.node.setAttribute('aria-hidden', item.aria);
      });
      hiddenSiblings = [];
      launch.disabled = false;
      if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus();
      else launch.focus();
    }

    async function cancel() {
      if (!overlay || stage === 'applying' || stage === 'cancelling' || stage === 'reload') return;
      stage = 'cancelling';
      token = null;
      setStatus('Onarım ekranı kapatılıyor…', true, false);
      setButtons();
      try {
        if (currentRequest) await currentRequest;
        await api.cancelEncodingRepair();
        close();
      } catch (error) { fail(error, true); }
    }

    function reload() {
      try { window.location.reload(); }
      catch (error) {
        stage = 'reload';
        setStatus('Onarım tamamlandı. Satışa devam etmeden önce “Uygulamayı Yenile” düğmesine basın.\n' + String(error), false, true);
        setButtons();
        retryButton.focus();
      }
    }

    async function apply() {
      if (!overlay || stage !== 'ready' || !token) return;
      var confirmedToken = token;
      token = null;
      stage = 'applying';
      setStatus('Onarım uygulanıyor. Lütfen bekleyin…', true, false);
      setButtons();
      try { await api.applyEncodingRepair(confirmedToken); }
      catch (error) { fail(error, false); return; }
      setStatus('Onarım tamamlandı. Uygulama yenileniyor…', false, false);
      reload();
    }

    function open() {
      if (overlay) return;
      previousFocus = document.activeElement;
      launch.disabled = true;
      overlay = element('div');
      overlay.id = 'koc-encoding-overlay';
      dialog = element('section');
      dialog.id = 'koc-encoding-dialog';
      dialog.tabIndex = -1;
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'koc-encoding-title');
      var title = element('h2', 'Türkçe Adları Onar');
      title.id = 'koc-encoding-title';
      dialog.appendChild(title);
      dialog.appendChild(element('p', 'Önce güncel verinin yedeği alınır ve önerilen düzeltmeler gösterilir. Onarım yalnızca siz onayladığınızda uygulanır.'));
      status = element('div', undefined, 'koc-encoding-status');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      dialog.appendChild(status);
      details = element('div');
      dialog.appendChild(details);
      var actions = element('div', undefined, 'koc-encoding-actions');
      cancelButton = element('button', 'Şimdi Değil', 'koc-encoding-cancel');
      cancelButton.type = 'button';
      cancelButton.addEventListener('click', cancel);
      retryButton = element('button', 'Tekrar Dene', 'koc-encoding-retry');
      retryButton.type = 'button';
      retryButton.hidden = true;
      retryButton.addEventListener('click', function () {
        if (stage === 'reload') reload();
        else if (stage === 'error' && cancelFailed) cancel();
        else if (stage === 'error') preview(true);
      });
      applyButton = element('button', 'Onar ve Yenile', 'koc-encoding-confirm');
      applyButton.type = 'button';
      applyButton.disabled = true;
      applyButton.addEventListener('click', apply);
      actions.appendChild(cancelButton);
      actions.appendChild(retryButton);
      actions.appendChild(applyButton);
      dialog.appendChild(actions);
      overlay.appendChild(dialog);
      Array.prototype.forEach.call(document.body.children, function (node) {
        hiddenSiblings.push({ node: node, inert: node.inert, aria: node.getAttribute('aria-hidden') });
        node.inert = true;
        node.setAttribute('aria-hidden', 'true');
      });
      document.body.appendChild(overlay);
      stage = 'opening';
      dialog.focus();
      preview(false);
    }

    function focusedButtons() {
      return [cancelButton, retryButton, applyButton].filter(function (button) { return !button.disabled && !button.hidden; });
    }

    function key(event) {
      if (!overlay) return;
      event.stopImmediatePropagation();
      if (event.type === 'keydown' && event.key === 'Escape') {
        event.preventDefault();
        cancel();
        return;
      }
      if (event.type === 'keydown' && event.key === 'Tab') {
        event.preventDefault();
        var buttons = focusedButtons();
        if (!buttons.length) { dialog.focus(); return; }
        var index = buttons.indexOf(document.activeElement);
        index = event.shiftKey ? (index <= 0 ? buttons.length - 1 : index - 1) : (index + 1) % buttons.length;
        buttons[index].focus();
        return;
      }
      var targetButton = focusedButtons().indexOf(event.target) >= 0;
      if (!targetButton || (event.key !== 'Enter' && event.key !== ' ')) event.preventDefault();
    }

    ['keydown', 'keypress', 'keyup'].forEach(function (type) { window.addEventListener(type, key, true); });
    window.addEventListener('focusin', function (event) {
      if (!overlay || dialog.contains(event.target)) return;
      event.stopImmediatePropagation();
      var buttons = focusedButtons();
      (buttons[0] || dialog).focus();
    }, true);
    launch.addEventListener('click', open);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
