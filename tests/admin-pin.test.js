const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const pinKey = 'koc-admin-pin';
const pinKeys = [pinKey, pinKey + '-shadow', pinKey + '-emergency', pinKey + '-emergency-ts'];

function source(start, end) {
  const begin = html.indexOf(start);
  const finish = html.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin, start);
  return html.slice(begin, finish);
}

function setupPin() {
  const disk = new Map(pinKeys.map(key => [key, '0456']));
  const browser = new Map(disk), notices = [], writes = [];
  let rejected = false, now = 500000, shakes = 0;
  const document = { body: { inert:false } };
  const context = vm.createContext({
    Date: { now: () => now }, TextEncoder, document, console,
    LS: { getItem: key => disk.get(key) ?? null },
    window: { crypto:webcrypto, localStorage:{ removeItem:key => browser.delete(key) }, kocStore: {
      async commit(id, entries) {
        writes.push({ id, entries });
        if (rejected) throw new Error('Disk yazma hatası');
        for (const [key, raw] of Object.entries(entries)) {
          if (raw === null) disk.delete(key);
          else disk.set(key, raw);
        }
      }
    } },
    flash: text => notices.push(text),
    ui: { active: () => true, shake() { shakes++; } }
  });
  vm.runInContext(source('let dataCommitBusy', '// ── ÜLKER ÜRÜN LİSTESİ') +
    source('const {verifyAdminPin, replaceAdminPin}', 'function isAdmin()'), context);
  const execute = expression => vm.runInContext(expression, context);
  return { document, disk, browser, notices, writes, shakes: () => shakes,
    verify: pin => execute(`verifyAdminPin(${JSON.stringify(pin)},ui)`),
    replace: (from,to) => execute(`replaceAdminPin(${JSON.stringify(from)},${JSON.stringify(to)},ui)`),
    reject: value => { rejected = value; }, advance: ms => { now += ms; } };
}

test('legacy PIN migrates to a salted hash and drops active plaintext copies only after acknowledgement', async () => {
  const pin = setupPin();
  pin.reject(true);
  await assert.rejects(pin.verify('0456'), /Disk yazma hatası/);
  assert.equal(pin.disk.get(pinKey), '0456');
  assert.equal(pin.browser.size, 4);
  assert.equal(pin.document.body.inert, false);

  pin.reject(false);
  assert.equal(await pin.verify('0456'), true);
  const stored = JSON.parse(pin.disk.get(pinKey));
  assert.match(stored, /^pbkdf2:[a-f\d]{32}:[a-f\d]{64}$/);
  for (const key of pinKeys.slice(1)) {
    assert.equal(pin.writes.at(-1).entries[key], null);
    assert.equal(pin.disk.has(key), false);
  }
  assert.equal(pin.browser.size, 0);
  assert.equal(await pin.verify('0456'), true);
  assert.equal(pin.writes.length, 2);
  assert.equal(await pin.replace('1111', '1357'), false);
  assert.equal(pin.writes.length, 2);
  assert.equal(await pin.replace('0456', '1357'), true);
  assert.notEqual(JSON.parse(pin.disk.get(pinKey)), stored);
  assert.equal(await pin.verify('0456'), false);
  assert.equal(await pin.verify('1357'), true);
});

test('three wrong PIN attempts delay even a correct PIN without altering the profile', async () => {
  const pin = setupPin();
  for (let i = 0; i < 3; i++) assert.equal(await pin.verify('0000'), false);
  assert.equal(await pin.verify('0456'), false);
  assert.equal(pin.shakes(), 3);
  assert.match(pin.notices.at(-1), /5 sn bekleyin/);
  assert.equal(pin.writes.length, 0);
  pin.advance(5000);
  assert.equal(await pin.verify('0456'), true);
});

test('admin settings check authorization when saving and again after a category deletion confirmation', async () => {
  const node = { id:'one',name:'One',active:true };
  let permitted = false, requests = 0, writes = 0, confirm;
  const ctx = vm.createContext({
    isAdmin: () => permitted, requireAdmin: () => { requests++; }, flash() {},
    _categoryById: () => node, _activeCategories: () => [node], selectedSettingsCategoryId:'one', products:[],
    categoryState: { categories:[node] }, escHtml: x=>x,
    appConfirm: opts => { confirm = opts.onOk; },
    saveCategoryState: async () => { writes++; },
    commitRecords: async () => { writes++; }
  });
  vm.runInContext(source('async function commitAdminSettings', 'function renderProductStockSettings') +
    source('function deleteSettingsCategory()', 'function computeTopSellers('), ctx);
  await vm.runInContext('saveBusinessSettings()',ctx);
  assert.equal(requests, 1);
  assert.equal(await vm.runInContext('commitAdminSettings({},()=>{})',ctx), false);
  assert.equal(writes, 0);
  permitted = true;
  vm.runInContext('deleteSettingsCategory()',ctx);
  assert.equal(typeof confirm, 'function');
  permitted = false;
  await confirm();
  assert.equal(node.active, true);
  assert.equal(writes, 0);
});
