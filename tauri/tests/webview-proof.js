// Yalnızca izole doğrulama ikilisinin yüklediği tarayıcı betiği.
(async () => {
  'use strict';

  const stage = window.__KOC_VERIFY_STAGE;
  if (!['sqlite', 'json', 'reopen', 'realistic'].includes(stage)) return;
  const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args || {});
  const barcode = '8699991234567';
  const customerId = 'proof-customer';
  const startupMs = Math.round(performance.now());
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const note = (event, details = {}) => invoke('test_log', {
    msg: JSON.stringify({ proof: stage, event, ...details })
  });

  function check(condition, message) {
    if (!condition) throw new Error(message);
  }

  async function until(predicate, message) {
    const limit = performance.now() + 10_000;
    while (!await predicate()) {
      check(performance.now() < limit, message);
      await pause(30);
    }
  }

  function click(selector) {
    const element = document.querySelector(selector);
    check(element, 'Gerekli arayüz düğmesi bulunamadı: ' + selector);
    element.click();
  }

  function product() {
    return products.find(item => item.b === barcode);
  }

  function assertCsp() {
    const events = window.__KOC_VERIFY_CSP;
    check(Array.isArray(events), 'CSP gözlemcisi yüklenmedi.');
    check(events.length === 0, 'CSP ihlali: ' + events.join(', '));
  }

  function pinDigits(value) {
    for (const digit of value) click('#pinBoxOverlay button[data-k="' + digit + '"]');
  }

  async function assertDeniedWrite(key, value) {
    let denied = false;
    try {
      await invoke('kv_apply', { ops: [{ key, op: 'set', val: JSON.stringify(value) }] });
    } catch (error) {
      denied = /yönetici|yetki/i.test(String(error));
    }
    check(denied, 'Kasiyerin yerel yazma girişimi reddedilmedi: ' + key);
  }

  function makePricePdf() {
    const stream = 'BT /F1 12 Tf 40 740 Td (' + barcode + ') Tj 180 0 Td (25,50 TL) Tj ET\n';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Length ' + stream.length + ' >>\nstream\n' + stream + 'endstream'
    ];
    // Belgenin tamamı ASCII olduğu için karakter ve bayt konumları eşit.
    let text = '%PDF-1.4\n';
    const offsets = [];
    objects.forEach((object, index) => {
      offsets.push(text.length);
      text += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
    });
    const xref = text.length;
    text += 'xref\n0 6\n0000000000 65535 f \n';
    for (const offset of offsets) text += String(offset).padStart(10, '0') + ' 00000 n \n';
    text += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    return new File([new TextEncoder().encode(text)], 'Prova.pdf', { type: 'application/pdf' });
  }

  async function verifyLocalPdf() {
    openPriceUpdateWizard();
    click('#pwBtn-pdf');
    const input = document.getElementById('wizPdfFile');
    check(input, 'PDF fiyat dosyası alanı bulunamadı.');
    const selection = new DataTransfer();
    selection.items.add(makePricePdf());
    input.files = selection.files;

    let workerReplied = false;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        const source = new URL(url, location.href);
        if (source.origin === location.origin && source.pathname.endsWith('/legacy/build/pdf.worker.min.mjs')) {
          this.addEventListener('message', () => { workerReplied = true; });
        }
      }
    };
    try {
      await processPdfForPrices();
      const review = document.getElementById('pdfReviewOverlay');
      const [item] = window._pdfReviewRows || [];
      check(review && item?.matched && item.barcode === barcode && item.pdfPrice === 25.5 &&
        review.textContent.includes('25,50 ₺'), 'PDF önizlemesinde barkod ile 25,50 TL bulunamadı.');
      check(workerReplied, 'Yerel PDF.js worker dosyası yanıt vermedi.');
      assertCsp();
      const cancel = Array.from(review.querySelectorAll('button')).find(button => button.textContent === 'İptal');
      check(cancel, 'PDF önizlemesi iptal düğmesi bulunamadı.');
      cancel.click();
      check(!document.getElementById('pdfReviewOverlay') && product().p === 12.8,
        'PDF önizlemesi kapatılmadı veya katalog fiyatı değişti.');
      return { pdfPrice: item.pdfPrice, pdfWorker: true };
    } finally {
      window.Worker = NativeWorker;
    }
  }

  async function verifyPin() {
    check((await window.kocAdmin.status()).remainingMs === 0, 'Kasa başlangıçta kilitli olmalı.');
    await assertDeniedWrite('koc-business-settings', { ...businessSettings, name: 'Prova - değişmemeli' });
    await assertDeniedWrite('koc-prods', products.map(p => p.b === barcode ? { ...p, p: 12.81 } : p));
    switchTab('products');
    click('#lockBtn');
    pinDigits('1234');
    await until(() => isAdmin() && !document.getElementById('pinBoxOverlay'), 'Varsayılan PIN arayüzde açılmadı.');
    check((await window.kocAdmin.status()).remainingMs > 0, 'Yerel yönetici oturumu açılmadı.');
    click('#lockBtn');
    await until(async () => !isAdmin() && (await window.kocAdmin.status()).remainingMs === 0,
      'Kilit düğmesi kasiyere dönmedi ve yerel oturumu kapatmadı.');

    click('#lockBtn');
    click('#pinChangeLink');
    pinDigits('1234');
    await until(() => document.querySelector('#pinBoxOverlay .modal-title')?.textContent === 'Yeni PIN',
      'PIN değiştirme adımı açılmadı.');
    pinDigits('2468');
    await until(() => document.querySelector('#pinBoxOverlay .modal-title')?.textContent === 'Yeni PIN (tekrar)',
      'PIN tekrar doğrulama adımı açılmadı.');
    pinDigits('2468');
    await until(() => !document.getElementById('pinBoxOverlay'), 'Yeni PIN kaydedilmedi.');
    check((await window.kocAdmin.status()).remainingMs === 0, 'PIN değişiminden sonra yerel oturum açık kaldı.');
    check(!(await window.kocAdmin.unlock('1234')).ok, 'Eski PIN geçerli kaldı.');
    click('#lockBtn');
    pinDigits('2468');
    await until(() => isAdmin(), 'Yeni PIN arayüzde açılmadı.');
    check((await window.kocAdmin.status()).remainingMs > 0, 'Yeni PIN ile yerel oturum açılmadı.');
    const pdf = await verifyLocalPdf();
    click('#lockBtn');
    await until(async () => (await window.kocAdmin.status()).remainingMs === 0, 'Yeni PIN oturumu kilitlenmedi.');
    switchTab('sale');
    return pdf;
  }

  function scan(quantity) {
    const input = document.getElementById('barcodeInput');
    check(input, 'Barkod alanı bulunamadı.');
    for (let index = 0; index < quantity; index++) {
      input.focus();
      input.value = barcode;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    }
    check(cart.length === 1 && cart[0].q === quantity, 'Okutulan miktar sepette doğrulanamadı.');
  }

  async function cashSale(quantity, amount) {
    const count = sales.length;
    scan(quantity);
    click('.btn-pay');
    click('.pay-method.cash');
    const input = document.getElementById('payInput');
    check(input, 'Nakit ödeme alanı açılamadı.');
    input.value = amount;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    check(document.querySelector('#changeBox .change-val')?.textContent === '0,00 ₺', 'Para üstü 0,00 TL olmalı.');
    const start = performance.now();
    click('.btn-finish');
    await until(() => sales.length === count + 1 && cart.length === 0, 'Nakit satış kalıcılaşmadı.');
    const elapsedMs = Math.round((performance.now() - start) * 10) / 10;
    const receipt = sales[0];
    check(receipt.total === Number(amount.replace(',', '.')) && receipt.paid === receipt.total &&
      receipt.change === 0 && receipt.paymentMethod === 'cash', 'Nakit fiş özeti beklentiden farklı.');
    return { saleId: receipt.id, cashTotal: receipt.total, saleAcknowledgementMs: elapsedMs };
  }

  function checkRecovery() {
    check(sales.length === 3 && new Set(sales.map(receipt => receipt.id)).size === 3, 'Üç benzersiz fiş korunmadı.');
    check(product().s === 5, 'SQLite dönüşünde stok 5 olmalı.');
    const amounts = sales.map(receipt => receipt.total).sort((a,b) => a-b);
    check(JSON.stringify(amounts) === JSON.stringify([12.8,12.8,38.4]), 'Fişlerin tutarları eşleşmiyor.');
    const credit = sales.filter(receipt => receipt.paymentMethod === 'cari' && receipt.customerId === customerId);
    check(credit.length === 1 && cariState.lots.some(lot => lot.saleId === credit[0].id && lot.customerId === customerId),
      'Veresiye fişi doğru cari kalemine bağlı değil.');
    check(window.KocCari.customerBalance(cariState, customerId) === 12.8, 'Cari bakiye 12,80 TL olmalı.');
    return { saleIds: sales.map(receipt => receipt.id), stock: product().s, balance: 12.8 };
  }

  try {
    check(window.kocApp?.platform === 'tauri' && window.kocAdmin, 'Yerel Tauri köprüsü yüklenmedi.');
    check(typeof finishSale === 'function' && typeof window.KocCari?.customerBalance === 'function',
      'Kasa betikleri yüklenmedi.');
    check(product()?.n === 'İÇİM ŞÖLEN Prova' && product()?.p === 12.8, 'Türkçe örnek ürün açılışta korunmadı.');
    check(await window.kocApp.flush(), 'Açılış yazmaları diske inmedi.');
    assertCsp();
    const { engine } = await window.kocApp.info();
    check(engine === (stage === 'json' ? 'json' : 'sqlite'), 'Beklenmeyen depo motoru: ' + engine);
    const startup = { engine, startupMs, cspViolations: 0, turkishText: true };
    await note('ready', startup);

    if (stage === 'sqlite') {
      check(sales.length === 0 && product().s === 10, 'İlk prova profili boş olmalı.');
      const cash = await cashSale(3, '38,40');
      check(product().s === 7, 'Nakit satış stoktan üç ürün düşmeli.');
      const pdf = await verifyPin();
      await invoke('test_delay_next_write', { ms: 2000 });
      scan(1);
      click('.btn-pay');
      click('.pay-method.account');
      click('.cari-pay-row[data-customer-id="' + customerId + '"]');
      await pause(150);
      check(sales.length === 1 && cart.length === 1 && window.kocApp.pendingWrites() > 0,
        'Geciken diskte sepet veya fiş erken değişti.');
      assertCsp();
      // Başarı kaydı kapanış talebinden önce yazılır. Koşucu aynı işlemin
      // çıkıştan sonra gerçekten diskte olduğunu ayrıca denetler.
      await note('pass', { ...startup, ...cash, ...pdf, pinChanged: true, closeWhileWriting: true });
      await invoke('test_close');
      return;
    }

    let details;
    if (stage === 'json') {
      check(sales.length === 2 && product().s === 6, 'SQLite sonrası iki fiş ve stok 6 bekleniyordu.');
      details = await cashSale(1, '12,80');
      check(sales.length === 3 && product().s === 5, 'JSON satışından sonra üç fiş ve stok 5 bekleniyordu.');
    } else if (stage === 'reopen') {
      details = checkRecovery();
    } else {
      const baselineSales = sales.length;
      const baselineProducts = products.length;
      details = { ...await cashSale(1, '12,80'), baselineSales, baselineProducts };
    }
    assertCsp();
    await note('pass', { ...startup, ...details });
    await invoke('test_close');
  } catch (error) {
    await note('error', { message: String(error), cspViolations: window.__KOC_VERIFY_CSP || [] });
  }
})();
