const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cari = require('../cari-core.js');
const { assertAuthorized } = require('../native-authorization.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const first = html.indexOf('const BACKUP_DATA_KEYS');
const last = html.indexOf('// CSV parser', first);
const fixture = price => {
  const product = { b:'A', n:"Lay's", p:price, q:1, s:9, k:0 };
  const cariState = cari.addCreditSale(cari.addCustomer(cari.createState(), { id:'c1', name:'Örnek' }), {
    customerId:'c1', saleId:'s1', items:[product]
  });
  return {
    products:[product],
    sales:[{id:'s1', items:[product], total:price}],
    heldSales:[{id:10, cart:[product]}],
    cariState,
    businessSettings:{name:'Koç Market'},
    categoryState:{categories:[{id:'cat-1',name:'Market',parentId:null}]},
    operationalSettings:{units:['Adet'],vatRates:[0,20],defaultVat:0},
    userSettings:{users:[{id:'user-admin',name:'Yönetici',role:'admin'}]}
  };
};
const plain = value => JSON.parse(JSON.stringify(value));

function dailyBackupApp({ native = true } = {}) {
  const baseline = fixture(100);
  const stored = new Map();
  const writes = [];
  const browserStorage = {
    getItem: key => stored.get(key) ?? null,
    setItem(key, value) { writes.push([key, value]); stored.set(key, value); }
  };
  const window = { localStorage: browserStorage };
  if (native) {
    for (const [key, value] of [
      ['koc-prods', baseline.products], ['koc-sales', baseline.sales],
      ['koc-held', baseline.heldSales], ['koc-cari-state', baseline.cariState]
    ]) stored.set(key, JSON.stringify(value));
    window.kocStore = {
      read: browserStorage.getItem,
      commit: async (id, entries) => {
        writes.push(plain(entries));
        await window.waitForDisk;
        if (window.diskError) throw window.diskError;
        const changes = [...Object.entries(entries), ['koc-atomic-last-operation', id]];
        assertAuthorized(Object.fromEntries(stored), changes, false);
        for (const [key, value] of changes) stored.set(key, value);
      }
    };
  }
  const context = vm.createContext({
    ...baseline, window, cart:[], paying:false, dataCommitBusy:false, newOperationId:() => 'backup-1',
    save() {}, setTimeout() {}, console:{warn() {}}
  });
  const browserStart = html.indexOf('function browserStore()');
  const browserEnd = html.indexOf('let dataCommitBusy', browserStart);
  vm.runInContext(html.slice(browserStart, browserEnd), context);
  context.LS = native ? { getItem:browserStorage.getItem, setItem:browserStorage.setItem } : context.browserStore();
  const dailyStart = html.indexOf('const MAX_BACKUPS');
  const dailyEnd = html.indexOf('// ── YEDEK YÖNETİCİSİ', dailyStart);
  const readStart = html.indexOf('function readBackupList()');
  const readEnd = html.indexOf('function backupCounts(', readStart);
  vm.runInContext(html.slice(dailyStart, dailyEnd) + html.slice(readStart, readEnd), context);
  return { baseline, context, stored, window, writes };
}

test('günlük yedek açık sepet, ödeme veya toplu kayıt bitene kadar başlamaz', async () => {
  const { context, stored, writes } = dailyBackupApp();
  context.cart = [{b:'A'}];
  assert.equal(await context.maybeDailyBackup(), false);
  context.cart = [];
  context.paying = true;
  assert.equal(await context.maybeDailyBackup(), false);
  context.paying = false;
  context.dataCommitBusy = true;
  assert.equal(await context.maybeDailyBackup(), false);
  assert.equal(writes.length, 0);
  assert.equal(stored.has('koc-last-auto-backup-date'), false);
  context.dataCommitBusy = false;
  assert.equal(await context.maybeDailyBackup(), true);
  assert.equal(writes.length, 1);
});

test('günlük yedek ve tarihi tek disk onayında yazılır, eşzamanlı istek yedek çoğaltmaz', async () => {
  const { baseline, context, stored, window, writes } = dailyBackupApp();
  let acknowledge;
  window.waitForDisk = new Promise(resolve => { acknowledge = resolve; });

  const first = context.maybeDailyBackup();
  assert.equal(await context.maybeDailyBackup(), false);
  assert.equal(writes.length, 1);
  assert.equal(stored.has('koc-backups'), false);
  assert.equal(stored.has('koc-last-auto-backup-date'), false);

  acknowledge();
  assert.equal(await first, true);
  const [backup] = JSON.parse(stored.get('koc-backups'));
  assert.equal(backup.reason, 'Günlük otomatik yedek');
  for (const [key, value] of Object.entries(baseline)) assert.deepEqual(backup[key], value);
  assert.equal(stored.get('koc-last-auto-backup-date'), context._todayKey());
  assert.equal(await context.maybeDailyBackup(), false);
  assert.equal(writes.length, 1);
});

test('yerel yazma reddi yedeği ve tarihi değiştirmez, gün içinde yeniden denenebilir', async () => {
  const { context, stored, window, writes } = dailyBackupApp();
  stored.set('koc-backups', '[{"ts":1}]');
  stored.set('koc-last-auto-backup-date', '2020-01-01');
  window.diskError = Object.assign(new Error('Kayıt reddedildi.'), {code:'permission_denied'});
  assert.equal(await context.maybeDailyBackup(), false);
  assert.equal(stored.get('koc-backups'), '[{"ts":1}]');
  assert.equal(stored.get('koc-last-auto-backup-date'), '2020-01-01');

  window.diskError = null;
  assert.equal(await context.maybeDailyBackup(), true);
  assert.equal(JSON.parse(stored.get('koc-backups')).length, 2);
  assert.equal(stored.get('koc-last-auto-backup-date'), context._todayKey());
  assert.equal(writes.length, 2);
});

test('eski tarih işareti tek başına bugünün otomatik yedeği sayılamaz', async () => {
  const { context, stored } = dailyBackupApp();
  const manual = {ts:Date.now(), reason:'Kullanıcı tarafından'};
  const oldDaily = {ts:1, reason:'Günlük otomatik yedek'};
  stored.set('koc-backups', JSON.stringify([manual, oldDaily]));
  stored.set('koc-last-auto-backup-date', context._todayKey());

  assert.equal(await context.maybeDailyBackup(), true);
  const [added, ...retained] = JSON.parse(stored.get('koc-backups'));
  assert.equal(added.reason, oldDaily.reason);
  assert.equal(context._todayKey(new Date(added.ts)), context._todayKey());
  assert.deepEqual(retained, [manual, oldDaily]);

  const reopened = dailyBackupApp();
  for (const [key, value] of stored) reopened.stored.set(key, value);
  assert.equal(await reopened.context.maybeDailyBackup(), false);
  assert.equal(reopened.writes.length, 0);
});

test('tarayıcı önizlemesinde yedek ve gün tek depolama kaydıyla yazılır', async () => {
  const { context, stored, writes } = dailyBackupApp({native:false});
  assert.equal(await context.maybeDailyBackup(), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'koc-atomic-browser-data');
  const data = JSON.parse(stored.get('koc-atomic-browser-data'));
  assert.equal(JSON.parse(data['koc-backups']).length, 1);
  assert.equal(data['koc-last-auto-backup-date'], context._todayKey());
});

function app() {
  const baseline = fixture(100);
  const ui = { confirmations:[], alerts:[], commits:[], files:[], stamps:[], imports:[] };
  let internal = [];
  const context = vm.createContext({
    ...plain(baseline), cart:[], paying:false, dataCommitBusy:false, MAX_BACKUPS:10,
    appConfirm: options => ui.confirmations.push(options),
    appAlert: message => ui.alerts.push(message),
    escHtml: value => value,
    isAdmin: () => true,
    newOperationId: () => 'op-1',
    commitRecords: async (id, values, publish) => {
      if (ui.fail) throw new Error('disk');
      ui.commits.push({ id, values:plain(values) });
      publish();
    },
    flash() {}, applyBusinessSettings() {}, populateKdvDropdowns() {}, refreshCategoryDatalist() {},
    renderProds() {}, renderQuick() {}, renderHistory() {}, renderCariPage() {}, updateHeldBadge() {}, updateStats() {},
    document:{getElementById: () => null},
    _activeCategories: () => context.categoryState.categories,
    requestProductImport: (records, csv) => ui.imports.push({ records:plain(records), csv }),
    parseCsvProducts: () => baseline.products,
    saveFileSmart: async (...args) => { ui.files.push(args); return {ok:true, browser:true}; },
    LS:{
      getItem: () => JSON.stringify(internal),
      setItem: (...args) => ui.stamps.push(args)
    },
    stockIsCounted: product => product.s > 0
  });
  vm.runInContext(html.slice(first, last)
    .replace(/async function saveFileSmart\(/, 'async function applicationSaveFileSmart('), context);
  return { baseline, context, ui, backups: supplied => { internal = supplied; } };
}

test('tam dosya yedeği ve iç yedek indirme işlemi aynı veri türlerini taşır', async () => {
  const { baseline, context, ui, backups } = app();
  await context.doExportJson();
  const [fullName, full] = ui.files[0];
  assert.match(fullName, /^koc-tam-yedek-/);
  const output = JSON.parse(full);
  assert.equal(output.schemaVersion, 4);
  assert.equal(output.customerCount, 1);
  assert.equal(output.cariEntryCount, 1);
  for (const [field, value] of Object.entries(baseline)) assert.deepEqual(output[field], value);

  backups([{...baseline, ts:Date.now()}]);
  await context.downloadBackup(0);
  const downloaded = JSON.parse(ui.files[1][1]);
  for (const [field, value] of Object.entries(baseline)) assert.deepEqual(downloaded[field], value);
  assert.equal(ui.stamps.length, 1);
  await context.doExportCsv();
  assert.equal(ui.stamps.length, 1);
});

test('tek önizlemede vazgeçmek belleği ve kalıcı veriyi değiştirmez', () => {
  const { baseline, context, ui } = app();
  context.processImportedFile(JSON.stringify(fixture(25)), 'tam.json');
  assert.equal(ui.confirmations.length, 1);
  assert.match(ui.confirmations[0].bodyHtml, /1 cari ve 1 cari hareket/);
  assert.match(ui.confirmations[0].bodyHtml, /4 \/ 4 ayar grubu/);
  ui.confirmations[0].onCancel?.();
  assert.equal(ui.commits.length, 0);
  assert.deepEqual(plain(context.currentBackupData()), baseline);
});

test('Tauri günlük yedeği tek kayıtta katalog, satış, cari ve ayarları geri yükler', async () => {
  const { baseline, context, ui } = app();
  const restored = fixture(25);
  const raw = Object.fromEntries(Object.entries(context.backupStateFromData(restored))
    .map(([key, value]) => [key, JSON.stringify(value)]));
  raw['koc-prods-shadow'] = '[]';
  context.processImportedFile(JSON.stringify(raw), 'gunluk-yedek-2026-11-27.json');
  assert.equal(ui.confirmations.length, 1);
  assert.match(ui.confirmations[0].bodyHtml, /27\.11\.2026/);
  await ui.confirmations[0].onOk();
  assert.equal(ui.commits.length, 1);
  assert.equal(ui.commits[0].values['koc-backups'][0].products[0].p, baseline.products[0].p);
  assert.deepEqual(plain(context.currentBackupData()), restored);
  assert.ok(!Object.hasOwn(ui.commits[0].values,'koc-prods-shadow'));
});

test('eski iç yedek carileri korur, disk hatasında bellek güncellenmez', async () => {
  const { baseline, context, ui, backups } = app();
  backups([{products:[], sales:[], ts:10}]);
  context.restoreBackup(0);
  ui.fail = true;
  await ui.confirmations[0].onOk();
  assert.deepEqual(plain(context.currentBackupData()), baseline);
  assert.match(ui.alerts[0], /disk/);
  ui.fail = false;
  context.restoreBackup(0);
  await ui.confirmations[1].onOk();
  assert.equal(ui.commits.length, 1);
  assert.deepEqual(plain(context.cariState), baseline.cariState);
  assert.deepEqual(plain(context.products), []);
});

test('bozuk ayar veya ham yedek önizleme açmadan reddedilir', () => {
  const { context, ui } = app();
  context.processImportedFile(JSON.stringify({...fixture(25), categoryState:{categories:[
    {id:'cat-1',name:'Market',parentId:'cat-1'}
  ]}}), 'tam.json');
  context.processImportedFile(JSON.stringify({'koc-prods':'[]','koc-sales':'{'}), 'gunluk.json');
  assert.equal(ui.confirmations.length, 0);
  assert.equal(ui.commits.length, 0);
  assert.match(ui.alerts[0], /Kategori ağacı geçersiz/);
  assert.match(ui.alerts[1], /koc-sales/);
});

test('ürün dosyaları yedek geri yüklemeden bağımsız aktarım yoluna gider', () => {
  const { baseline, context, ui } = app();
  context.processImportedFile(JSON.stringify({products:baseline.products}), 'urunler.json');
  context.processImportedFile('BARKOD;URUN ADI;FIYAT\nA;Ürün;100', 'urunler.csv');
  assert.equal(ui.confirmations.length, 0);
  assert.deepEqual(ui.imports, [
    { records:baseline.products, csv:false },
    { records:baseline.products, csv:true }
  ]);
});
