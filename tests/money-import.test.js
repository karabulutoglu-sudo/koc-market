const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function scope(extra = {}) {
  const names = ['parsePrice','toCents','readCsvRows','parseCsvProducts','requestProductImport','commitProductChanges'];
  return vm.createContext({
    isAdmin:() => true,
    dataCommitBusy:false,
    products:[],
    cariState:{},
    operationalSettings:{defaultVat:20},
    applyCariPriceChanges:() => ({}),
    newOperationId:() => 'test-op',
    commitRecords:async (id, records, publish) => publish(),
    _normBarcode:value => String(value ?? '').trim(),
    _activeCategories:() => [],
    escHtml:value => value,
    ...extra
  }, {name:'Para ve aktarım testleri'});
}

function makeScope(extra) {
  const context = scope(extra);
  const names = ['parsePrice','readCsvRows','parseCsvProducts','requestProductImport','commitProductChanges'];
  for (const name of names) {
    const source = html.match(new RegExp('^(?:async )?function ' + name + '\\([^\\n]*[\\s\\S]*?^}', 'm'))?.[0];
    assert.ok(source, name);
    vm.runInContext(source, context);
  }
  return context;
}

test('fiyat ayrıştırıcısı TR ve EN fiyatlarını aynı okur ve bozuk tutarları durdurur', () => {
  assert.equal((html.match(/^function parsePrice\(/gm) || []).length, 1);
  const {parsePrice} = makeScope();
  for (const s of ['25,50','25.50','25,50 ₺']) assert.equal(parsePrice(s), 25.50);
  for (const s of ['1.250,50','1,250.50']) assert.equal(parsePrice(s), 1250.50);
  for (const s of ['', 'abc', '-2,50', '25.50abc', '1,00.50']) assert.ok(Number.isNaN(parsePrice(s)), s);
});

test('CSV 25.50 ve %0 oranını bozmadan okur, tırnaklı çok satırlı alanı korur', () => {
  const app = makeScope();
  const text = '\uFEFFsep=;\r\nBARKOD;URUN ADI;FIYAT;KDV\r\n001;"İlk satır;\r\n""ikinci""";25.50;%0';
  const [item] = app.parseCsvProducts(text);
  assert.deepEqual({...item}, {b:'001',n:'İlk satır;\r\n"ikinci"',p:25.50,k:0});
  assert.throws(() => app.parseCsvProducts('BARKOD;URUN ADI;FIYAT\n001;Ürün;abc'), /geçerli fiyat/);
});

test('yalnız zorunlu CSV sütunları stok, kategori ve KDV’yi korur ve fiyat artışını cariye iletir', async () => {
  const existing = {b:'001',n:'Eski ürün',p:20,s:7,c:'İçecek',k:0};
  let confirmation;
  let observed;
  const app = makeScope({
    products:[existing,{b:'eski',p:2},{b:'eski',p:3}],
    appConfirm:options => { confirmation = options; },
    applyCariPriceChanges:changes => { observed = changes; return {}; },
    makeBackup:() => {},
    _migrateCategoryTree:() => {},
    renderProds:() => {},
    renderQuick:() => {},
    refreshCategoryDatalist:() => {},
    flash:() => {}
  });
  app.requestProductImport(app.parseCsvProducts('BARKOD;URUN ADI;FIYAT\n001;Yeni ad;25.50'), true);
  await confirmation.onOk();
  assert.deepEqual({...app.products[0]}, {...existing,n:'Yeni ad',p:25.50});
  assert.deepEqual(Array.from(app.products.slice(1),p => p.p), [2,3]);
  assert.deepEqual({...observed[0]}, {barcode:'001',newPrice:25.50});
});
