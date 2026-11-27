import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';

const [command, profile, version, port] = process.argv.slice(2);
if (process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Windows' ||
    process.env.GITHUB_REF !== 'refs/heads/codex/yayin1-onsurum-kabul' ||
    profile !== path.join(process.env.APPDATA, 'com.kocmarket.app')) {
  throw new Error('Sentetik profil işlemi geçici Windows kabul VM gerektirir.');
}

const product = {b:'8699991234567', n:'İÇİM ŞÖLEN Kabul Provası', p:12.8, s:10, stockTracked:true, c:'İçecek', k:10};
const legacy = {id:'kabul-2-0-4', at:1732000000000, total:12.8, paid:12.8, change:0,
  paymentMethod:'cash', items:[{b:product.b,n:product.n,p:12.8,q:1,k:10}]};
const dbPath = path.join(profile, 'kocmarket.db');

function seed() {
  fs.mkdirSync(profile);
  const kv = {
    'koc-prods': JSON.stringify([product]),
    'koc-sales': JSON.stringify([legacy]),
    'koc-held': '[]',
    'koc-admin-pin': '1234',
    'koc-ulker-v6-yuklendi': '1',
    'koc-kat-birlesim-v1': '1',
    'koc-kdv-migrated-v1': '1',
    'koc-kdv-sigara-fix-v10': '1',
    'koc-son-yedek': String(Date.now())
  };
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT); CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)');
    const put = db.prepare('INSERT INTO kv VALUES (?,?,?)');
    for (const [key, value] of Object.entries(kv)) put.run(key, value, new Date().toISOString());
    db.prepare('INSERT INTO meta VALUES (?,?)').run('migration_done', 'Sentetik yükseltme provası');
  } finally { db.close(); }
  fs.writeFileSync(path.join(profile, 'koc-data.json'), JSON.stringify(kv), {flag:'wx'});
}

async function findWebView() {
  assert.match(port, /^4342[89]$/);
  const until = Date.now() + 45_000;
  let diagnostics = 'Yerel WebView2 hata ayıklama adresi yanıt vermedi.';
  do {
    let targets;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {signal:AbortSignal.timeout(1_000)});
      if (response.ok) {
        targets = await response.json();
        diagnostics = `Yerel hedefler: ${targets.map(({type, url}) => `${type}:${String(url).split('?')[0]}`).join(', ')}`;
      } else diagnostics = `Yerel WebView2 adresi HTTP ${response.status} döndürdü.`;
    } catch { /* Pencere hazır olana kadar bekle. */ }
    const page = targets?.find(({type, url}) => type === 'page' && /^(?:https?:\/\/tauri\.localhost|tauri:\/\/localhost)\//.test(url));
    if (page) {
      const endpoint = new URL(page.webSocketDebuggerUrl);
      assert.ok(['127.0.0.1','localhost'].includes(endpoint.hostname));
      assert.equal(endpoint.port, port);
      assert.equal(endpoint.protocol, 'ws:');
      endpoint.hostname = '127.0.0.1';
      return endpoint.toString();
    }
    await delay(200);
  } while (Date.now() < until);
  throw new Error(`Kurulu ${version} WebView2 penceresi 45 saniyede hazır olmadı. ${diagnostics}`);
}

async function evaluateInstalledApp() {
  const socket = new WebSocket(await findWebView());
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Yerel WebView2 bağlantısı zaman aşımına uğradı.')), 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once:true});
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Yerel WebView2 bağlantısı açılamadı.')); }, {once:true});
    });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Kurulu uygulama prova komutunu tamamlamadı.')), 25_000);
      socket.addEventListener('message', ({data}) => {
        const response = JSON.parse(data);
        if (response.id !== 1) return;
        clearTimeout(timer);
        if (response.error || response.result.exceptionDetails) {
          reject(new Error(response.result?.exceptionDetails?.exception?.description || response.error?.message || 'Uygulama betiği hata verdi.'));
        } else resolve(response.result.result.value);
      });
      socket.send(JSON.stringify({id:1, method:'Runtime.evaluate', params:{awaitPromise:true, returnByValue:true, expression:`(async () => {
        const until = async (condition) => {
          const limit = Date.now() + 8000;
          while (!condition()) {
            if (Date.now() > limit) throw new Error('Kasa görünümü veya satış hazır olmadı.');
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        };
        const barcode = ${JSON.stringify(product.b)};
        await until(() => document.readyState === 'complete' && window.kocStore &&
          typeof sales !== 'undefined' && typeof products !== 'undefined');
        if (sales.length !== 1 || sales[0].id !== 'kabul-2-0-4' || products.find(item => item.b === barcode)?.s !== 10) {
          throw new Error('Sentetik eski fiş veya stok açılışta eşleşmedi.');
        }
        if (${JSON.stringify(version)} === '2.1.0') {
          if (typeof window.kocStore.commitSale !== 'function') throw new Error('Satır bazlı SQLite satış yolu açılmadı.');
          const click = (selector) => document.querySelector(selector).click();
          const input = document.getElementById('barcodeInput');
          input.value = barcode;
          input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true}));
          click('.btn-pay');
          click('.pay-method.cash');
          const amount = document.getElementById('payInput');
          amount.value = '12,80';
          amount.dispatchEvent(new Event('input', {bubbles:true}));
          click('.btn-finish');
          await until(() => sales.length === 2 && cart.length === 0);
          if (!await window.kocApp.flush()) throw new Error('Kasa yazım kuyruğu boşalmadı.');
          if (sales[0].total !== 12.8 || sales[0].paymentMethod !== 'cash' || products.find(item => item.b === barcode)?.s !== 9) {
            throw new Error('Yeni fiş veya güncel stok hatalı.');
          }
        }
        return {receipts:sales.length, stock:products.find(item => item.b === barcode)?.s};
      })()`}}));
    });
    console.log(`WEBVIEW2 ${version} ${JSON.stringify(result)}`);
  } finally { socket.close(); }
}

function verifyDisk() {
  const logDir = path.join(profile,'logs');
  const log = fs.readdirSync(logDir).filter(name => name.endsWith('.log')).map(name =>
    fs.readFileSync(path.join(logDir,name),'utf8')).join('\n');
  const upgraded = version === '2.1.0';
  assert.ok((log.match(/Depo düzgün kapatıldı\./g)?.length ?? 0) >= (upgraded ? 2 : 1), 'Normal depo kapanışı kanıtı eksik.');
  const db = new DatabaseSync(dbPath, {readOnly:true});
  try {
    assert.equal(db.prepare("SELECT type FROM sqlite_schema WHERE name='kv'").get().type,'table');
    const rawSales = db.prepare("SELECT value FROM kv WHERE key='koc-sales'").get().value;
    const receipts = JSON.parse(rawSales);
    const stock = JSON.parse(db.prepare("SELECT value FROM kv WHERE key='koc-prods'").get().value).find(item => item.b === product.b).s;
    assert.equal(receipts.at(-1).id, legacy.id);
    assert.equal(receipts.at(-1).total, legacy.total);
    assert.equal(receipts.at(-1).items[0].b, product.b);
    assert.equal(receipts.length, upgraded ? 2 : 1);
    assert.equal(stock, upgraded ? 9 : 10);
    if (upgraded) {
      assert.equal(receipts[0].total, 12.8);
      assert.equal(receipts[0].paymentMethod, 'cash');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM koc_sales').get().count, 2);
      const mirror = JSON.parse(fs.readFileSync(path.join(profile,'koc-data.json'),'utf8'));
      assert.equal(mirror['koc-sales'], rawSales);
    }
    console.log(`DİSK ${version} fiş ${receipts.length}, stok ${stock}`);
  } finally { db.close(); }
}

assert.ok(['2.0.4','2.1.0'].includes(version));
if (command === 'seed') seed();
else if (command === 'webview') await evaluateInstalledApp();
else if (command === 'disk') verifyDisk();
else throw new Error(`Bilinmeyen prova komutu (${command}).`);
