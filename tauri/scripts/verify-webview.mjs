import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const {addCustomer, createState} = require(path.join(root, 'cari-core.js'));
const proof = fs.readFileSync(new URL('../tests/webview-proof.js', import.meta.url), 'utf8');
const [exeArg, sampleArg, mode, ...unexpected] = process.argv.slice(2);
const scale = mode === '--scale';
if (process.platform !== 'win32' || !exeArg || unexpected.length || (mode && !scale)) {
  throw new Error('Kullanım: node tauri/scripts/verify-webview.mjs <doğrulama.exe> [yerel-örnek.json [--scale]]');
}
const exe = path.resolve(exeArg);
assert.equal(path.basename(exe).toLowerCase(), 'koc-market.exe');
assert.ok(fs.statSync(exe).isFile(), 'Doğrulama ikilisi yok.');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'koc-webview-proof-'));
const product = {b:'8699991234567', n:'İÇİM ŞÖLEN Prova', p:12.8, s:10, stockTracked:true, c:'İçecek', k:10};
const customerId = 'proof-customer';
console.log('İzole prova klasörü', sandbox);

function profileFolder(name) {
  const dir = path.join(sandbox,name);
  fs.mkdirSync(dir);
  return dir;
}

function newProfile(name, sample = {}, {legacyDecimals = false, alreadyBackedUp = false} = {}) {
  const dir = profileFolder(name);
  const operational = { schemaVersion:1, units:['Adet'], defaultUnit:'Adet', defaultCriticalStock:2,
    trackStock:true, allowNegativeStock:false, defaultVat:20, vatRates:[0,1,10,20], priceRounding:'0.01' };
  const initial = {
    'koc-prods':[...sample.products || [], product],
    'koc-sales':sample.sales || [],
    'koc-held':sample.heldSales || [],
    'koc-cari-state':sample.cariState || addCustomer(createState(),{id:customerId,name:'Örnek Cari'}),
    'koc-business-settings':{name:'İzole Prova',subtitle:'WebView2'},
    'koc-operational-settings':operational
  };
  const kv = Object.fromEntries(Object.entries(initial).map(([key,value]) => [key,JSON.stringify(value)]));
  if (legacyDecimals) {
    kv['koc-sales'] = kv['koc-sales'].replace(/"(p|total|paid)":60(?=[,}])/g, '"$1":60.0');
    assert.match(kv['koc-sales'], /"total":60\.0/);
  }
  if (legacyDecimals || alreadyBackedUp) {
    const today = new Date();
    kv['koc-last-auto-backup-date'] = [today.getFullYear(), today.getMonth() + 1, today.getDate()]
      .map(part => String(part).padStart(2, '0')).join('-');
    // Büyük geçmişte ölçülen işlem satış. Başlangıçtaki yedek üretimi bu ayrı provanın dışında.
    if (alreadyBackedUp) {
      kv['koc-backups'] = JSON.stringify([{ts:today.getTime(),reason:'Günlük otomatik yedek'}]);
    }
  }
  kv['koc-admin-pin'] = '1234';
  kv['koc-son-yedek'] = String(Date.now());
  fs.writeFileSync(path.join(dir,'koc-data.json'),JSON.stringify(kv),{flag:'wx'});
  return dir;
}

function readLog(p) {
  try { return fs.readFileSync(p,'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

async function runStage(dir, stage) {
  const file = path.join(dir,'proof.js');
  const logfile = path.join(dir,'logs','webview-proof.log');
  const script = 'globalThis.__KOC_VERIFY_STAGE=' + JSON.stringify(stage) + ';\n' + proof;
  fs.writeFileSync(file,script);
  const started = performance.now();
  const child = spawn(exe, [], {cwd:dir, env:{...process.env, KOC_DATA_DIR:dir, KOC_TEST_JS:file, RUST_BACKTRACE:'1'},
    stdio:['ignore','ignore','ignore']});
  let outcome;
  child.once('error', error => { outcome = {error}; });
  child.once('exit', code => { outcome = {code}; });
  let entry;
  let readyMs;
  try {
    while (performance.now() - started < 75000) {
      for (const line of readLog(logfile).split(/\r?\n/)) {
        if (!line.startsWith('{')) continue;
        let item;
        try { item = JSON.parse(line); } catch { continue; }
        if (item.proof !== stage) continue;
        if (item.event === 'ready') readyMs ??= Math.round(performance.now() - started);
        if (item.event === 'error') throw new Error(stage + ': ' + item.message);
        if (item.event === 'pass') entry = item;
      }
      if (outcome) {
        if (outcome.error) throw outcome.error;
        assert.equal(outcome.code,0,stage + ' beklenmedik çıkış');
        assert.ok(entry,stage + ' başarı kaydı yok');
        console.log(JSON.stringify({...entry, launchToReadyMs:readyMs}));
        return entry;
      }
      await delay(35);
    }
    throw new Error(stage + ' 75 saniyede tamamlanamadı. Günlük: ' + logfile);
  } finally {
    if (!outcome) child.kill();
  }
}

function readDb(dir) {
  const db = new DatabaseSync(path.join(dir,'kocmarket.db'),{readOnly:true});
  try {
    assert.equal(db.prepare("SELECT type FROM sqlite_master WHERE name='kv'").get()?.type, 'table',
      'Düzgün kapanıştan sonra eski sürüm için yazılabilir kv tablosu bulunmalı.');
    return Object.fromEntries(db.prepare('SELECT key,value FROM kv').all().map(row => [row.key,row.value]));
  }
  finally { db.close(); }
}

function verifyBackupOnDisk(data, expectedOriginalSales) {
  const [backup] = JSON.parse(data['koc-backups']);
  assert.equal(backup.reason, 'Günlük otomatik yedek');
  assert.equal(backup.sales.length, expectedOriginalSales);
  assert.match(data['koc-last-auto-backup-date'], /^\d{4}-\d{2}-\d{2}$/);
}

function getSample() {
  if (!sampleArg) return null;
  const sample = JSON.parse(fs.readFileSync(path.resolve(sampleArg),'utf8'));
  assert.ok(Array.isArray(sample.products) && Array.isArray(sample.sales),'Örnek yedek biçimi geçersiz.');
  assert.ok(!sample.products.some(p => p.b === product.b),'Örnek barkod yedekte zaten var.');
  return sample;
}

function logLines(dir, prefix) {
  return fs.readdirSync(path.join(dir,'logs')).flatMap(name =>
    readLog(path.join(dir,'logs',name)).split(/\r?\n/).filter(line => line.includes(prefix)));
}

async function measureLargeHistory(sample) {
  assert.equal(sample?.sales.length,8241,'--scale için 8.241 fişlik örnek yedek gerekli.');
  const seeded = {...sample,cariState:addCustomer(sample.cariState || createState(),{id:customerId,name:'Örnek Cari'})};
  for (const stage of ['scale-cash','scale-credit']) {
    const dir = newProfile(stage,seeded,{alreadyBackedUp:true});
    const result = await runStage(dir,stage);
    const committed = readDb(dir);
    const sales = JSON.parse(committed['koc-sales']);
    const method = stage === 'scale-cash' ? 'cash' : 'cari';
    assert.equal(sales.length,8242);
    assert.equal(new Set(sales.map(sale => String(sale.id))).size,8242);
    assert.equal(sales[0].id,result.saleId);
    assert.equal(sales[0].paymentMethod,method);
    assert.equal(sales[0].total,12.8);
    for (const [index, original] of sample.sales.entries()) {
      assert.deepEqual(sales[index + 1],original,`Örnek satışın içeriği veya sırası değişti (${index}).`);
    }
    assert.equal(JSON.parse(committed['koc-prods']).find(p => p.b === product.b).s,9);
    const accounts = JSON.parse(committed['koc-cari-state']);
    if (method === 'cari') {
      const entries = accounts.entries.filter(entry => entry.customerId === customerId);
      const lots = accounts.lots.filter(lot => lot.customerId === customerId);
      assert.equal(entries.length,1);
      assert.equal(entries[0].debitCents,1280);
      assert.equal(entries[0].referenceId,result.saleId);
      assert.equal(lots.length,1);
      assert.equal(lots[0].saleId,result.saleId);
    } else {
      assert.deepEqual(accounts,seeded.cariState);
    }
    const mirror = JSON.parse(fs.readFileSync(path.join(dir,'koc-data.json'),'utf8'));
    assert.equal(mirror['koc-sales'],committed['koc-sales'],'Kapanışta ayna ve eski sürüm fişleri eşleşmedi.');
    const [saleLine] = logLines(dir,'PROOF_SALE_WRITE');
    const [closeLine] = logLines(dir,'PROOF_STORE_CLOSE');
    assert.equal(logLines(dir,'PROOF_SALE_WRITE').length,1,'Tek satış işleminin yerel ölçümü bulunmalı.');
    const saleStats = saleLine?.match(/elapsed_ms=([\d.]+) logical_bytes=(\d+) wal_before_bytes=(\d+) wal_delta_bytes=(-?\d+)/);
    const closeStats = closeLine?.match(/elapsed_ms=([\d.]+)/);
    assert.ok(saleStats && closeStats,'Satış ve kapanış ölçümleri bulunmalı.');
    const [, nativeMs, logicalBytes, walBefore, walDelta] = saleStats.map(Number);
    assert.equal(walBefore,0,'Satış ölçümü boş WAL ile başlamalı.');
    assert.ok(walDelta > 0,'SQLite satış yazımı için WAL ölçümü pozitif olmalı.');
    console.log(JSON.stringify({measurement:stage, historySize:8241, durableReceipts:8242,
      saleAcknowledgementMs:result.saleAcknowledgementMs, nativeMs, logicalBytes, walBefore, walDelta,
      nativeCloseMs:Number(closeStats[1]), acknowledgementTargetMet:result.saleAcknowledgementMs < 200,
      walTargetMet:walDelta < 500_000}));
  }
}

async function runStandard(sample) {
  const clean = profileFolder('temiz');
  await runStage(clean,'clean');
  const cleanData = readDb(clean);
  verifyBackupOnDisk(cleanData,0);
  assert.equal(JSON.parse(cleanData['koc-sales']).length,1);

  const decimalReceipt = {
    id:'eski-ondalik-fis', at:1, total:60, paid:60, change:0, paymentMethod:'cash',
    items:[{b:'test-gecmis',n:'Örnek eski kalem',p:60,q:1,k:20}]
  };
  const oldDecimals = newProfile('eski-ondalik',{sales:[decimalReceipt]},{legacyDecimals:true});
  await runStage(oldDecimals,'old-decimal');
  const decimalData = readDb(oldDecimals);
  verifyBackupOnDisk(decimalData,1);
  const [newReceipt,oldReceipt] = JSON.parse(decimalData['koc-sales']);
  assert.equal(newReceipt.total,12.8);
  assert.deepEqual(oldReceipt,decimalReceipt);
  assert.match(decimalData['koc-sales'], /"total":60\.0/, 'Eski fişin ham ondalık biçimi korunmalı.');

  const queue = newProfile('yedek-kuyrugu');
  const queued = await runStage(queue,'queue');
  const queuedData = readDb(queue);
  verifyBackupOnDisk(queuedData,0);
  assert.equal(queuedData['koc-last-auto-backup-date'],queued.backupDate);
  assert.equal(queuedData['koc-son-acilis-gunu'],queued.normalWriteDate);
  const [saved] = JSON.parse(queuedData['koc-sales']);
  assert.equal(JSON.parse(queuedData['koc-sales']).length,1);
  assert.equal(saved.id,queued.saleId);
  assert.equal(saved.total,12.8);
  assert.equal(JSON.parse(queuedData['koc-prods']).find(p => p.b === product.b).s,9);

  const synthetic = newProfile('sentetik');
  await runStage(synthetic,'sqlite');
  const first = readDb(synthetic);
  assert.match(first['koc-admin-pin'],/pbkdf2:[a-f0-9]+:[a-f0-9]+/);
  assert.equal(JSON.parse(first['koc-sales']).length,2);
  const sqlite = path.join(synthetic,'kocmarket.db');
  assert.ok(!fs.existsSync(sqlite + '-wal') || fs.statSync(sqlite + '-wal').size === 0,'SQLite kapanış kontrolü geçmedi.');
  const parked = path.join(synthetic,'prova-sqlite-bekliyor.db');
  fs.renameSync(sqlite,parked);
  fs.mkdirSync(sqlite);
  try {
    await runStage(synthetic,'json');
  } finally {
    fs.rmdirSync(sqlite);
    fs.renameSync(parked,sqlite);
  }
  await runStage(synthetic,'reopen');
  const restored = readDb(synthetic);
  const sales = JSON.parse(restored['koc-sales']);
  const saleIds = new Set(sales.map(s => String(s.id)));
  assert.equal(saleIds.size,3);
  assert.ok(JSON.parse(first['koc-sales']).every(s => saleIds.has(String(s.id))));
  assert.equal(JSON.parse(restored['koc-prods']).find(p => p.b === product.b).s,5);
  const account = JSON.parse(restored['koc-cari-state']);
  const creditSale = sales.find(s => s.paymentMethod === 'cari');
  assert.equal(creditSale.customerId,customerId);
  assert.ok(account.lots.some(lot => lot.customerId === customerId && String(lot.saleId) === String(creditSale.id)));
  assert.equal(account.entries.filter(e => e.customerId === customerId)
    .reduce((amount,e) => amount + e.debitCents - e.creditCents,0),1280);
  assert.ok(fs.readdirSync(path.join(synthetic,'backups')).filter(name =>
    name.startsWith('json-uzlastirma-oncesi-')).length >= 2);
  console.log('PASS SQLite → JSON → SQLite: 3 fiş, stok 5, cari bakiye 12,80 TL, iki doğrulanmış kaynak yedeği.');

  if (sample) {
    const realistic = newProfile('ornek-yedek',sample);
    const result = await runStage(realistic,'realistic');
    const committed = readDb(realistic);
    assert.equal(JSON.parse(committed['koc-sales']).length,sample.sales.length+1);
    const nativeMetrics = logLines(realistic,'PROOF_SALE_WRITE');
    assert.ok(nativeMetrics.length,'Native satış yazma ölçümü bulunamadı.');
    console.log(JSON.stringify({sampleProducts:sample.products.length, sampleSales:sample.sales.length,
      measuredSaleMs:result.saleAcknowledgementMs, nativeMetrics}));
  }
}

const sample = getSample();
if (scale) await measureLargeHistory(sample);
else await runStandard(sample);
