const test = require('node:test');
const assert = require('node:assert/strict');
const cari = require('../cari-core.js');

function seeded() {
  return cari.addCustomer(cari.createState(), { id: 'c1', name: 'Yılmaz Nakliyat', createdAt: 1 });
}

test('cari satış banka ekstresi gibi borç ve bakiye oluşturur', () => {
  const state = cari.addCreditSale(seeded(), {
    customerId: 'c1',
    saleId: 's1',
    at: 100,
    items: [{ barcode: 'A', productName: 'Ürün A', quantity: 2, unitPrice: 50 }]
  });
  assert.equal(cari.customerBalance(state, 'c1'), 100);
  assert.deepEqual(cari.statement(state, 'c1').map(x => [x.type, x.debit, x.credit, x.balance]), [
    ['credit_sale', 100, 0, 100]
  ]);
});

test('mevcut Koç Market sepet ve ürün alanları doğrudan cariye akar', () => {
  const state = cari.addCreditSale(seeded(), {
    customerId: 'c1',
    saleId: 'legacy-cart',
    at: 100,
    items: [{ b: '8690504009542', n: 'Ülker Çiziviç', p: 25, q: 3, k: 10 }]
  });
  assert.equal(cari.customerBalance(state, 'c1'), 75);
  assert.deepEqual(
    state.lots.map(lot => [lot.barcode, lot.productName, lot.originalQuantity, cari.money(lot.originalUnitPriceCents)]),
    [['8690504009542', 'Ülker Çiziviç', 3, 25]]
  );
});

test('ödeme FIFO ile önce en eski ürün borcunu kapatır', () => {
  let state = seeded();
  state = cari.addCreditSale(state, {
    customerId: 'c1', saleId: 'old', at: 100,
    items: [{ barcode: 'A', productName: 'Eski ürün', quantity: 1, unitPrice: 500 }]
  });
  state = cari.addCreditSale(state, {
    customerId: 'c1', saleId: 'new', at: 200,
    items: [{ barcode: 'B', productName: 'Yeni ürün', quantity: 1, unitPrice: 300 }]
  });
  state = cari.recordPayment(state, {
    customerId: 'c1', paymentId: 'p1', at: 300, amount: 600, method: 'cash'
  });
  const payment = state.entries.find(x => x.type === 'payment');
  assert.deepEqual(payment.details.allocations.map(x => [x.saleId, cari.money(x.appliedCents)]), [
    ['old', 500],
    ['new', 100]
  ]);
  assert.equal(cari.customerBalance(state, 'c1'), 200);
  assert.equal(state.lots.find(x => x.saleId === 'old').outstandingCents, 0);
  assert.equal(state.lots.find(x => x.saleId === 'new').outstandingCents, 20000);
});

test('yukarı yönlü fiyat farkı yalnız açık ürün miktarına eklenir', () => {
  let state = seeded();
  state = cari.addCreditSale(state, {
    customerId: 'c1', saleId: 's1', at: 100,
    items: [{ barcode: 'A', productName: 'İçecek', quantity: 4, unitPrice: 50 }]
  });
  state = cari.recordPayment(state, {
    customerId: 'c1', paymentId: 'p1', at: 200, amount: 100
  });
  state = cari.applyPriceIncrease(state, {
    barcode: 'A', newPrice: 60, updateId: 'u1', at: 300
  });
  // Dört adetten ikisi ödendi; kalan iki açık adede 10'ar lira fark.
  assert.equal(cari.customerBalance(state, 'c1'), 120);
  const adjustment = state.entries.find(x => x.type === 'price_adjustment');
  assert.equal(cari.money(adjustment.debitCents), 20);
  assert.equal(adjustment.details.adjustments[0].openQuantity, 2);
});

test('aşağı yönlü fiyat cari bakiyesini kesinlikle düşürmez', () => {
  let state = seeded();
  state = cari.addCreditSale(state, {
    customerId: 'c1', saleId: 's1', at: 100,
    items: [{ barcode: 'A', productName: 'Ürün', quantity: 2, unitPrice: 100 }]
  });
  const before = cari.customerBalance(state, 'c1');
  state = cari.applyPriceIncrease(state, { barcode: 'A', newPrice: 80, at: 200 });
  assert.equal(cari.customerBalance(state, 'c1'), before);
  assert.equal(state.entries.filter(x => x.type === 'price_adjustment').length, 0);
  assert.equal(state.lots[0].highestAppliedUnitPriceCents, 10000);
});

test('fiyat düşüp eski seviyenin altında yükselirse cari farkı oluşmaz', () => {
  let state = seeded();
  state = cari.addCreditSale(state, {
    customerId: 'c1', saleId: 's1', at: 100,
    items: [{ barcode: 'A', productName: 'Ürün', quantity: 1, unitPrice: 100 }]
  });
  state = cari.applyPriceIncrease(state, { barcode: 'A', newPrice: 80, at: 200 });
  state = cari.applyPriceIncrease(state, { barcode: 'A', newPrice: 95, at: 300 });
  assert.equal(cari.customerBalance(state, 'c1'), 100);
  assert.equal(state.entries.filter(x => x.type === 'price_adjustment').length, 0);
});

test('eski en yüksek fiyat aşılırsa yalnız aşan bölüm uygulanır', () => {
  let state = seeded();
  state = cari.addCreditSale(state, {
    customerId: 'c1', saleId: 's1', at: 100,
    items: [{ barcode: 'A', productName: 'Ürün', quantity: 1, unitPrice: 100 }]
  });
  state = cari.applyPriceIncrease(state, { barcode: 'A', newPrice: 80, at: 200 });
  state = cari.applyPriceIncrease(state, { barcode: 'A', newPrice: 110, at: 300 });
  assert.equal(cari.customerBalance(state, 'c1'), 110);
  assert.equal(cari.money(state.entries.find(x => x.type === 'price_adjustment').debitCents), 10);
});

test('tamamen ödenmiş ürüne sonradan zam farkı yazılmaz', () => {
  let state = seeded();
  state = cari.addCreditSale(state, {
    customerId: 'c1', saleId: 's1', at: 100,
    items: [{ barcode: 'A', productName: 'Ürün', quantity: 1, unitPrice: 100 }]
  });
  state = cari.recordPayment(state, { customerId: 'c1', amount: 100, at: 200 });
  state = cari.applyPriceIncrease(state, { barcode: 'A', newPrice: 150, at: 300 });
  assert.equal(cari.customerBalance(state, 'c1'), 0);
  assert.equal(state.entries.filter(x => x.type === 'price_adjustment').length, 0);
});

test('fazla ödeme banka hesabı gibi cariyi alacaklı bakiyeye geçirir', () => {
  let state = seeded();
  state = cari.addCreditSale(state, {
    customerId: 'c1', saleId: 's1', at: 100,
    items: [{ barcode: 'A', productName: 'Ürün', quantity: 1, unitPrice: 100 }]
  });
  state = cari.recordPayment(state, { customerId: 'c1', amount: 150, at: 200 });
  assert.equal(cari.customerBalance(state, 'c1'), -50);
  const payment = state.entries.find(x => x.type === 'payment');
  assert.equal(cari.money(payment.details.unallocatedCreditCents), 50);
});

test('gerçek uygulama cari durumunu ayrı güvenli veri anahtarında tutar', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /safeLoadJSON\(\s*'koc-cari-state'/);
  assert.match(html, /safeSaveJSON\('koc-cari-state', nextState\)/);
  assert.doesNotMatch(html, /safeSaveJSON\('koc-prods', nextState\)/);
});

test('cari ödeme sırasında sepeti bozmadan yeni cari ekleme akışı bulunur', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /onclick="openNewCariFromPayment\(\)">＋ YENİ CARİ EKLE/);
  assert.match(html, /function openNewCariFromPayment\(\)/);
  assert.match(html, /function saveNewCariFromPayment\(\)/);
  assert.match(html, /paymentMethod = 'cari';\s*renderCart\(\)/);
  assert.doesNotMatch(html, /function openNewCariFromPayment\(\)[\s\S]{0,1200}cart\s*=\s*\[\]/);
});
