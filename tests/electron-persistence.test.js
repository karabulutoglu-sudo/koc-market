const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const crypto = require('node:crypto');

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
const marker = 'koc-atomic-last-operation';
const salt = Buffer.alloc(16, 1);
const pin = 'pbkdf2:' + salt.toString('hex') + ':' + crypto.pbkdf2Sync('1234', salt, 210000, 32, 'sha256').toString('hex');
const bootFlags = Object.fromEntries(['koc-migrated-to-disk-v1','koc-ulker-v6-yuklendi','koc-kat-birlesim-v1',
  'koc-barcode-cleanup-v1','koc-kdv-migrated-v1','koc-kdv-sigara-fix-v10','koc-category-tree-native-v1'].map(key => [key,'1']));
const stock = n => JSON.stringify([{ b:'869', n:'İçecek', p:10, s:n, stockTracked:true, k:20, c:'İçecek' }]);
const initial = { ...bootFlags, 'koc-admin-pin':pin, 'koc-prods':stock(10), 'koc-sales':'[]', 'koc-held':'[{"id":"cart"}]' };
const changes = { 'koc-prods':stock(9), 'koc-sales':'[{"id":"sale-1","total":10}]', 'koc-cari-state':'{"saleId":"sale-1"}',
  'koc-held':'[]' };

function setup(directory, options = {}) {
  const syncHandlers = new Map(), asyncHandlers = new Map(), renderer = {};
  const electron = {
    app: { isPackaged: false, getPath: () => directory, whenReady: () => ({ then() {} }), on() {} },
    ipcMain: { on: (key, fn) => syncHandlers.set(key, fn), handle: (key, fn) => asyncHandlers.set(key, fn) },
    ipcRenderer: {
      sendSync(key, args) {
        const event = {};
        syncHandlers.get(key)(event, args);
        return event.returnValue;
      },
      async invoke(key, args) { return asyncHandlers.get(key)({}, args); }
    },
    contextBridge: { exposeInMainWorld: (key, value) => { renderer[key] = value; } }
  };
  const getDependency = name => {
    if (name === 'electron') return electron;
    if (name === 'electron-updater') return {};
    if (name === 'better-sqlite3') {
      if (options.Database) return options.Database;
      throw new Error('JSON fixture');
    }
    if (name === 'fs' && options.fs) return options.fs;
    if (name === './native-authorization') return require('../native-authorization');
    return require(name);
  };
  const context = { require: getDependency, __dirname:path.join(__dirname,'..'), structuredClone, console: { log() {}, error() {} } };
  vm.createContext(context);
  const startup = options.sqliteOnly
    ? "dataFilePath = path.join(app.getPath('userData'), 'koc-data.json'); dbFilePath = path.join(app.getPath('userData'), 'kocmarket.db'); initSqlite();"
    : 'setupDataStore();';
  vm.runInContext(main + '\n' + startup, context);
  vm.runInContext(preload, context);
  return { ...renderer, evaluate: script => vm.runInContext(script, context), close: () => {
    vm.runInContext('if (db) { db.close(); db = null; }', context);
  } };
}

function testDirectory(t, seed = initial) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'koc-electron-persist-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (seed) fs.writeFileSync(path.join(directory, 'koc-data.json'), JSON.stringify(seed));
  return directory;
}

test('Electron IPC commits JSON together and a replacement error leaves previous disk and memory intact', async t => {
  const directory = testDirectory(t), file = path.join(directory, 'koc-data.json');
  let blockReplace = true;
  const simulatedFs = { ...fs, renameSync(src, dest) {
    if (dest === file && blockReplace) throw new Error('denied replacement');
    return fs.renameSync(src, dest);
  } };
  const s = setup(directory, { fs: simulatedFs });
  assert.equal((await s.kocAdmin.unlock('1234')).ok, true);
  await assert.rejects(s.kocStore.commit('sale-1', changes), /denied replacement/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), initial);
  assert.equal(s.kocStore.read('koc-prods'), stock(10));
  assert.equal(s.kocStore.read('koc-held'), initial['koc-held']);
  assert.equal(s.kocStore.read(marker), null);
  assert.equal(s.kocStore.write('legacy-setting', 'true'), false);
  assert.equal(s.kocStore.read('legacy-setting'), null);

  blockReplace = false;
  assert.equal((await s.kocStore.commit('sale-1', changes)).alreadyCommitted, false);
  assert.equal(s.kocStore.read('koc-prods'), stock(9));
  assert.equal(s.kocStore.read('koc-cari-state'), changes['koc-cari-state']);
  assert.equal(s.kocStore.read('koc-held'), '[]');
  const reopened = setup(directory);
  assert.equal(reopened.kocStore.read('koc-sales'), changes['koc-sales']);
  assert.equal((await reopened.kocStore.commit('sale-1', { 'koc-prods': stock(8) })).alreadyCommitted, true);
  assert.equal(reopened.kocStore.read('koc-prods'), stock(9));
  assert.equal(reopened.kocStore.remove(marker), false);
});

function loadSqlite() {
  try { return require('node:sqlite').DatabaseSync; } catch (error) {
    if (error.code === 'ERR_UNKNOWN_BUILTIN_MODULE') return null;
    throw error;
  }
}

function databaseAdapter(DatabaseSync) {
  return class Database extends DatabaseSync {
    pragma(value) { this.exec('PRAGMA ' + value); }
    transaction(fn) {
      return (...args) => {
        this.exec('BEGIN');
        try {
          fn(...args);
          this.exec('COMMIT');
        } catch (error) {
          this.exec('ROLLBACK');
          throw error;
        }
      };
    }
  };
}

test('Electron groups stock, receipt and credit in one SQLite transaction', async t => {
  const DatabaseSync = loadSqlite();
  if (!DatabaseSync) return t.skip('Bu Node sürümünde node:sqlite yok.');
  const directory = testDirectory(t);
  const Database = databaseAdapter(DatabaseSync);
  const s = setup(directory, { Database });
  try {
    assert.equal((await s.kocAdmin.unlock('1234')).ok, true);
    s.evaluate(`db.exec("CREATE TRIGGER reject_sale BEFORE INSERT ON kv WHEN NEW.key = '${marker}' BEGIN SELECT RAISE(ABORT, 'commit failure'); END")`);
    await assert.rejects(s.kocStore.commit('sale-1', changes), /commit failure/);
    assert.equal(s.kocStore.read('koc-prods'), stock(10));
    assert.equal(s.evaluate("db.prepare(\"SELECT value FROM kv WHERE key = 'koc-prods'\").get().value"), stock(10));
    assert.equal(s.evaluate("db.prepare(\"SELECT COUNT(*) n FROM kv WHERE key = 'koc-cari-state'\").get().n"), 0);
    s.evaluate('db.exec("DROP TRIGGER reject_sale")');
    assert.equal((await s.kocStore.commit('sale-1', changes)).alreadyCommitted, false);
  } finally { s.close(); }

  const reopened = setup(directory, { Database });
  try {
    assert.equal(reopened.kocStore.read('koc-sales'), changes['koc-sales']);
    assert.equal(reopened.kocStore.read('koc-prods'), stock(9));
    assert.equal(reopened.kocStore.read('koc-cari-state'), changes['koc-cari-state']);
    assert.equal(reopened.kocStore.read('koc-held'), '[]');
    assert.equal((await reopened.kocStore.commit('sale-1', { 'koc-prods': stock(8) })).alreadyCommitted, true);
    assert.equal(reopened.kocStore.read('koc-prods'), stock(9));
  } finally { reopened.close(); }
});

const fallbackKey = 'koc-native-json-fallback-v1';
function scenario(second) {
  const sales = [{ id: 'sqlite-sale', total: 12 }];
  if (second) sales.push({ id: 'json-sale', customerId: 'c1', total: 12 });
  return {
    ...bootFlags,
    'koc-prods': JSON.stringify([{ b: '869', n: 'İçecek', p: 12, s: second ? 8 : 9 }]),
    'koc-sales': JSON.stringify(sales),
    'koc-held': JSON.stringify(second ? [] : [{ id: 'pending-1' }]),
    'koc-cari-state': JSON.stringify({
      customers: [{ id: 'c1', name: 'Işıl' }],
      entries: second ? [{ id: 'e1', saleId: 'json-sale', debitCents: 1200 }] : [],
      lots: second ? [{ id: 'l1', saleId: 'json-sale', outstandingCents: 1200 }] : [],
    }),
    'koc-business-settings': JSON.stringify({ name: second ? 'Koç Market' : 'Market' }),
  };
}

function writeScenario(store, second) {
  store.evaluate('applyStoreEntries(Object.entries(' + JSON.stringify(scenario(second)) + '))');
}

test('Electron recovers a fallback sale, stock and credit in the same SQLite transaction', t => {
  const DatabaseSync = loadSqlite();
  if (!DatabaseSync) return t.skip('Bu Node sürümünde node:sqlite yok.');
  const Database = databaseAdapter(DatabaseSync);
  const directory = testDirectory(t, scenario(false));
  const file = path.join(directory, 'koc-data.json');
  const sqlite = setup(directory, { Database });
  writeScenario(sqlite, false);
  sqlite.evaluate('refreshLegacyMirror()');
  sqlite.close();
  const oldBackups = fs.readdirSync(path.join(directory, 'backups'));

  const fallback = setup(directory);
  writeScenario(fallback, true);
  const pending = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(JSON.parse(pending)[fallbackKey]).version, 1);
  assert.equal(fallback.kocStore.read(fallbackKey), null);

  const merged = setup(directory, { Database, sqliteOnly:true });
  try {
    assert.deepEqual(JSON.parse(merged.evaluate('JSON.stringify(memStore)')), scenario(true));
  } finally { merged.close(); }

  // SQLite işleminden sonra, ayna yenilemesi gerçekleşmeden program kapanabilir.
  assert.equal(fs.readFileSync(file,'utf8'), pending);
  const recovered = setup(directory, { Database });
  try {
    assert.deepEqual({ ...recovered.kocDB.getAll() }, scenario(true));
    const saved = fs.readdirSync(path.join(directory, 'backups')).filter(name => name.startsWith('json-uzlastirma-oncesi-') && !oldBackups.includes(name));
    assert.equal(saved.length, 2);
    for (const [source, state] of [['sqlite', scenario(false)], ['fallback', scenario(true)]]) {
      const backup = path.join(directory, 'backups', saved.find(name => name.endsWith('-' + source + '.json')));
      assert.deepEqual(JSON.parse(fs.readFileSync(backup,'utf8')), state);
    }
    recovered.evaluate('refreshLegacyMirror()');
    assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')), scenario(true));
  } finally { recovered.close(); }
});

test('Electron recovery preserves both sources if SQLite and JSON changed the same record', t => {
  const DatabaseSync = loadSqlite();
  if (!DatabaseSync) return t.skip('Bu Node sürümünde node:sqlite yok.');
  const Database = databaseAdapter(DatabaseSync);
  const directory = testDirectory(t, scenario(false));
  const file = path.join(directory, 'koc-data.json');
  const sqlite = setup(directory, { Database });
  writeScenario(sqlite, false);
  sqlite.evaluate('refreshLegacyMirror()');
  sqlite.close();
  const oldBackups = fs.readdirSync(path.join(directory, 'backups'));
  const fallback = setup(directory);
  writeScenario(fallback, true);
  const pending = fs.readFileSync(file, 'utf8');

  const databaseFile = path.join(directory, 'kocmarket.db');
  const conn = new Database(databaseFile);
  try {
    conn.prepare("UPDATE kv SET value=? WHERE key='koc-prods'").run('changed in SQLite');
  } finally { conn.close(); }
  assert.throws(() => setup(directory, { Database }), /aynı alanı farklı değiştirdi: koc-prods/);
  assert.equal(fs.readFileSync(file,'utf8'), pending);
  const check = new Database(databaseFile);
  try {
    assert.equal(check.prepare("SELECT value FROM kv WHERE key='koc-prods'").get().value, 'changed in SQLite');
  } finally { check.close(); }
  assert.equal(fs.readdirSync(path.join(directory,'backups')).filter(name => !oldBackups.includes(name)).length, 2);
});

test('Electron rejects a stale mirror after a recent SQLite sale and can use it once refreshed', t => {
  const DatabaseSync = loadSqlite();
  if (!DatabaseSync) return t.skip('Bu Node sürümünde node:sqlite yok.');
  const Database = databaseAdapter(DatabaseSync);
  const directory = testDirectory(t, scenario(false));
  const file = path.join(directory, 'koc-data.json');
  const sqlite = setup(directory, { Database });
  const before = fs.readFileSync(file, 'utf8');
  writeScenario(sqlite, true);
  sqlite.close();
  assert.equal(fs.readFileSync(file,'utf8'), before);
  assert.equal(fs.readFileSync(path.join(directory,'koc-json-mirror-state'),'utf8'), 'dirty');
  assert.throws(() => setup(directory), /güncelliği doğrulanamadı/);
  assert.equal(fs.readFileSync(file,'utf8'), before);

  const recovery = setup(directory, { Database });
  recovery.close();
  const fallback = setup(directory);
  assert.deepEqual({ ...fallback.kocDB.getAll() }, scenario(true));
});
