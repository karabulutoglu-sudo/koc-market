// Çalıştırma: node tests/kasa-proof.js (Playwright + Chromium).
// İsteğe bağlı ortam ayarları: KOC_PLAYWRIGHT_PATH ve KOC_CHROMIUM_PATH.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.KOC_PLAYWRIGHT_PATH || 'playwright');
const cari = require('../cari-core.js');

const root = path.resolve(__dirname, '..');
const origin = 'https://kocmarket.invalid';
const cashCode = '8699990000001';
const creditCode = '8699990000002';
const customerId = 'proof-customer';
const customerName = 'Prova müşterisi';

function fixtures() {
  const customer = { id: customerId, name: customerName };
  const at = Date.now();
  return {
    'koc-ulker-v6-yuklendi': '1', 'koc-kat-birlesim-v1': '1',
    'koc-kdv-migrated-v1': '1', 'koc-kdv-sigara-fix-v10': '1',
    'koc-prods': JSON.stringify([
      { b: cashCode, n: "Lay's <Patates>", p: 12.8, c: 'Atıştırmalık', k: 20, s: 0 },
      { b: creditCode, n: 'Prova Çikolatası', p: 100, c: 'Atıştırmalık', k: 20, s: 10, stockTracked: true }
    ]),
    'koc-sales': JSON.stringify([{
      id: at, d: new Date(at).toLocaleString('tr-TR'), total: 5, paid: 5, change: 0,
      items: [{ b: cashCode, n: "Lay's <Patates>", p: 5, q: 1, k: 20 }]
    }]),
    'koc-held': JSON.stringify([{ id: at - 1, time: '10:20', cart: [{ b: cashCode, n: 'Bekleyen örnek', p: 12.8, q: 1, k: 20 }] }]),
    'koc-cari-state': JSON.stringify(cari.addCustomer(cari.createState(), customer)),
    'koc-business-settings': JSON.stringify({ name: 'Prova Market' }),
    'koc-user-settings': JSON.stringify({ schemaVersion: 1, users: [{ id:'user-admin', name:'Yönetici', role:'admin', active:true, createdAt:at }] }),
    'koc-operational-settings': JSON.stringify({ trackStock: true, allowNegativeStock: false, defaultVat: 20 })
  };
}

async function withProfile(browser, viewport, test, emulateTauri = false) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  try {
    const files = new Map([['/', 'index.html'], ['/barcode-core.js', 'barcode-core.js'], ['/cari-core.js', 'cari-core.js']]);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      const file = url.origin === origin && files.get(url.pathname);
      if (!file) return route.abort();
      const body = fs.readFileSync(path.join(root, file));
      await route.fulfill({ body, contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' });
    });
    if (emulateTauri) {
      const bridge = fs.readFileSync(path.join(root, 'tauri/src-tauri/src/bridge.js'), 'utf8');
      await context.addInitScript({ content: `(() => {
        if (location.origin !== ${JSON.stringify(origin)}) return;
        const fixture = ${JSON.stringify(fixtures())};
        const disk = JSON.parse(sessionStorage.getItem('proof-disk') || JSON.stringify(fixture));
        const calls = window.proofNativeCalls = [];
        window.__KOC_BOOT__ = { data: disk, engine: 'Prova' };
        window.__TAURI_INTERNALS__ = { async invoke(command, args) {
          calls.push(command);
          if (command === 'flush_done') return true;
          if (command !== 'kv_apply') return {};
          if (window.proofWriteGate) await window.proofWriteGate;
          for (const op of args.ops) {
            if (op.op === 'del') delete disk[op.key];
            else disk[op.key] = op.val;
          }
          sessionStorage.setItem('proof-disk', JSON.stringify(disk));
          return true;
        }};
        ${bridge}
      })();` });
    } else {
      await context.addInitScript(({seed,origin}) => {
        if (location.origin !== origin) return;
        if (localStorage.getItem('proof-initialized')) return;
        for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
        localStorage.setItem('proof-initialized', '1');
      }, {seed:fixtures(),origin});
    }
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || String(error)));
    await page.goto(origin + '/');
    await page.waitForFunction(() => typeof completeSale === 'function' && typeof renderProds === 'function');
    assert.deepEqual(errors, [], 'Açılış hatası');
    await test(page);
    assert.deepEqual(errors, [], 'Tarayıcı betik hatası');
  } finally {
    await context.close();
  }
}

async function tab(page, name) {
  await page.locator(`button.tab[onclick="switchTab('${name}')"]`).click();
}

async function scan(page, code) {
  const field = page.locator('#barcodeInput');
  await field.fill(code);
  await field.press('Enter');
}

async function cashierProof(page) {
  assert.deepEqual(await page.evaluate(() => [sales.length, heldSales.length]), [1, 1], 'Eski profil korunmalı');
  for (let i = 0; i < 3; i++) await scan(page, cashCode);
  await page.locator('.btn-pay').click();
  await page.locator('.pay-method.cash').click();
  await page.locator('#payInput').fill('38,40');
  assert.equal(await page.locator('#changeBox .change-val').textContent(), '0,00 ₺');
  await page.locator('.btn-finish').click();
  await page.waitForFunction(() => sales.length === 2 && cart.length === 0);
  assert.deepEqual(await page.evaluate(() => [sales[0].total, sales[0].paid, sales[0].change]), [38.4, 38.4, 0]);
  assert.equal(await page.locator('#appConfirmOverlay').count(), 0);

  await scan(page, creditCode);
  await page.locator('.btn-pay').click();
  await page.locator('.pay-method.account').click();
  await page.getByRole('button', { name: /Prova müşterisi/ }).waitFor();
  const results = await page.evaluate(async id => {
    const concurrent = await Promise.all([finishCariSale(id), finishCariSale(id)]);
    const saleId = sales[0].id;
    const repeat = await completeSale({ method: 'cari', customerId: id, paidCents: 0, saleId });
    return [concurrent, repeat, saleId];
  }, customerId);
  assert.deepEqual(results.slice(0, 2), [[true, false], true]);

  await page.reload();
  const stored = await page.evaluate(({ id, code, saleId }) => ({
    saleCount: sales.length,
    stock: products.find(p => p.b === code).s,
    linkedSales: sales.filter(s => s.id === saleId && s.customerId === id).length,
    linkedLots: cariState.lots.filter(l => l.saleId === saleId && l.customerId === id).length,
    balance: window.KocCari.customerBalance(cariState, id),
    heldCount: heldSales.length
  }), { id: customerId, code: creditCode, saleId: results[2] });
  assert.deepEqual(stored, { saleCount: 3, stock: 9, linkedSales: 1, linkedLots: 1, balance: 100, heldCount: 1 });

  await tab(page, 'history');
  const historyRow = page.getByRole('button', { name: /Lay's <Patates>/ }).first();
  await historyRow.focus();
  await historyRow.press('Enter');
  await page.locator('#receiptContent .receipt-title').waitFor();
  assert.match(await page.locator('#receiptContent').textContent(), /Lay's <Patates>/);
  const vat = await page.evaluate(code => {
    const product = products.find(p => p.b === code);
    const currentRate = product.k;
    product.k = 10;
    const sale = { id:'proof-vat', total:120, paid:120, change:0, paymentMethod:'cash',
      items:[{ b:code, n:product.n, p:120, q:1, k:20, totalCents:12000 }] };
    showReceipt(sale, false);
    product.k = currentRate;
    const rows = Array.from(document.querySelectorAll('#receiptContent .receipt-row'));
    return rows.find(row => row.textContent.includes('KDV %20'))?.lastElementChild.textContent;
  }, cashCode);
  assert.equal(vat, '20,00 ₺');

  await tab(page, 'products');
  const source = await page.evaluate(() => {
    const products = [{ b: '7777777777777', n: 'Değişmemeli', p: 50, s: 25 }];
    return JSON.stringify({ products, sales: [], heldSales: [], businessSettings: { name: 'Değişmemeli' } });
  });
  await page.evaluate(text => processImportedFile(text, 'prova.json'), source);
  if (await page.locator('#pinBoxOverlay').count()) {
    for (const n of '1234') await page.locator(`#pinBoxOverlay button[data-k="${n}"]`).click();
  }
  await page.locator('#appConfirmCancel').waitFor();
  assert.match(await page.locator('#appConfirmOverlay .modal-title').textContent(), /geri yükle/i);
  const snapshot = () => page.evaluate(() => ({ products, sales, heldSales, cariState, businessSettings,
    categoryState, operationalSettings, userSettings, raw: Object.entries(localStorage).sort() }));
  const before = await snapshot();
  await page.locator('#appConfirmCancel').click();
  assert.deepEqual(await snapshot(), before, 'İptalden sonra veri ve depo');
  await page.reload();
  assert.deepEqual(await snapshot(), before, 'Yeniden açılan veri ve depo');
  console.log('PASS kasa: eski profil, nakit 38,40/0, veresiye tekrarı, stok 9, fiş/cari, geçmiş KDV ve yedek iptali');
}

async function focusProof(page, viewport) {
  await tab(page, 'products');
  const edit = page.locator('#prodList .edit-btn').first();
  await edit.focus();
  await page.waitForTimeout(2200);
  assert.equal(await edit.evaluate(e => e === document.activeElement), true, 'Düzenle odağı');
  await tab(page, 'sale');
  await scan(page, cashCode);
  const payment = page.locator('.btn-pay');
  await payment.focus();
  await page.waitForTimeout(2200);
  assert.equal(await payment.evaluate(e => e === document.activeElement), true, 'Ödeme odağı');
  await payment.press('Enter');
  await page.locator('.pay-method.cash').waitFor();
  console.log(`PASS odak: ${viewport.width}×${viewport.height}, Düzenle + Ödeme, 2,2 sn`);
}

async function delayedCommitProof(page) {
  await page.evaluate(async () => { await window.kocApp.flush(); });
  await scan(page, cashCode);
  await page.locator('.btn-pay').click();
  await page.locator('.pay-method.cash').click();
  await page.locator('#payInput').fill('12,80');
  await page.evaluate(() => {
    window.proofWriteGate = new Promise(resolve => { window.proofRelease = resolve; });
    window.proofSale = finishSale();
    window.proofClose = window.__kocFlushAndClose();
  });
  await page.waitForTimeout(400);
  assert.deepEqual(await page.evaluate(() => [sales.length, cart.length, window.proofNativeCalls.includes('flush_done')]), [1, 1, false]);
  await page.evaluate(async () => { window.proofRelease(); await window.proofSale; await window.proofClose; });
  assert.deepEqual(await page.evaluate(() => [sales.length, cart.length, window.proofNativeCalls.includes('flush_done')]), [2, 0, true]);
  await page.reload();
  assert.equal(await page.evaluate(() => sales.length), 2);
  console.log('PASS Tauri köprüsü: simüle gecikmeli disk onayından önce sepet ve kapanış korundu, fiş yeniden açılışta var');
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.KOC_CHROMIUM_PATH, args: ['--disable-background-networking'] });
  try {
    const wide = { width:1366, height:768 };
    for (const viewport of [{ width:900, height:600 }, wide]) {
      await withProfile(browser, viewport, p => focusProof(p, viewport));
    }
    await withProfile(browser, wide, cashierProof);
    await withProfile(browser, wide, delayedCommitProof, true);
    const customer = { id: customerId, name: customerName };
    let state = cari.addCustomer(cari.createState(), customer);
    state = cari.recordPayment(state, { customerId, amount: 100 });
    state = cari.addCreditSale(state, { customerId, items: [{ b: creditCode, n:'Prova', p:100, q:1 }] });
    state = cari.applyPriceIncrease(state, { barcode: creditCode, newPrice: 120 });
    assert.equal(cari.customerBalance(state, customerId), 0);
    console.log('PASS cari: 100 TL avans + 100 TL veresiye + 120 TL fiyat artışı sonrası bakiye 0,00 TL');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
