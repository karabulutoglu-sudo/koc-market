const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const bridge = read('src-tauri/src/bridge.js');

function bridgeContext(persisted) {
  const window = {
    addEventListener() {},
    __TAURI_INTERNALS__: {
      async invoke(command, args) {
        assert.equal(command, 'kv_apply');
        for (const op of args.ops) {
          if (op.op === 'set') persisted.set(op.key, op.val);
          else persisted.delete(op.key);
        }
      }
    }
  };
  const context = vm.createContext({
    window, document: { readyState: 'loading', body: null, addEventListener() {} },
    setTimeout() {}, console
  });
  return { context, window };
}

test('HTML yanıtı açıkça UTF-8 olarak gönderilir', () => {
  assert.match(read('src-tauri/src/bootstrap.rs'), /HTML_CONTENT_TYPE: &str = "text\/html; charset=utf-8"/);
  assert.match(read('src-tauri/src/lib.rs'), /headers_mut\(\)\.insert\("Content-Type",[^\n]*bootstrap::HTML_CONTENT_TYPE/);
});

test('Tauri sürümleri ve güncelleme notları tutarlı', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(JSON.parse(read('src-tauri/tauri.conf.json')).version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.match(read('src-tauri/Cargo.toml'), new RegExp(`^version = "${pkg.version.replace(/\./g, '\\.')}"$`, 'm'));
  assert.match(read('src-tauri/Cargo.lock'), new RegExp(`name = "koc-market"\r?\nversion = "${pkg.version.replace(/\./g, '\\.')}"`));
  assert.ok(read('RELEASE_NOTES.md').includes(pkg.version));
});

test('köprü açılışta ürün, satış ve cari verisini değiştirmez', () => {
  const data = {
    'koc-prods': JSON.stringify([{ b: '8690504001065', n: 'ÜLKER ÇİKOLATA İÇİM ŞÖLEN', p: 24.5 }]),
    'koc-sales': JSON.stringify([{ items: [{ n: 'İÇİM SÜT', qty: 2 }], total: 49 }]),
    'koc-cari': JSON.stringify({ name: 'Özer Koç', note: 'ğşüıöç İĞŞÜÖÇ 😀' })
  };
  const persisted = new Map(Object.entries(data));
  const { context, window } = bridgeContext(persisted);
  window.__KOC_BOOT__ = { engine: 'sqlite', data, report: {} };
  vm.runInContext(bridge, context);
  assert.equal(window.kocApp.pendingWrites(), 0);
  assert.equal(window.__KOC_BOOT__, undefined);
  for (const [key, value] of Object.entries(data)) {
    assert.equal(window.kocStore.read(key), value);
    assert.equal(persisted.get(key), value);
  }
});

test('gerçek Rust açılış çıktısı Windows-1252 ile okunsa bile 5 açılışta kayıpsızdır', async (t) => {
  const available = spawnSync('rustc', ['--version'], { encoding: 'utf8' });
  if (available.error?.code === 'ENOENT') {
    t.skip('Bu bilgisayarda Rust yok; bu test Rust kurulu yayın iş akışında çalışır.');
    return;
  }
  assert.ifError(available.error);
  assert.equal(available.status, 0, available.stderr);
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koc-bootstrap-roundtrip-'));
  try {
    const exe = path.join(testDir, process.platform === 'win32' ? 'boot-fixture.exe' : 'boot-fixture');
    const compile = spawnSync('rustc', [
      '--edition=2021', '--cap-lints=allow', path.join(__dirname, 'boot-fixture.rs'), '-o', exe
    ], { encoding: 'utf8' });
    assert.ifError(compile.error);
    assert.equal(compile.status, 0, compile.stderr);
    const products = [{
      b: '8690504001065', n: 'ÜLKER ÇİKOLATA İÇİM ŞÖLEN ğşüıöç İĞŞÜÖÇ 😀', p: 24.5,
      note: '"alıntı" \\ yol \\u0130 </script><script>throw 1</script> <!-- \u2028\u2029'
    }];
    const originalSale = { id: 'eski-satis', items: products, total: 24.5 };
    const persisted = new Map(Object.entries({
      'koc-prods': JSON.stringify(products),
      'koc-sales': JSON.stringify([originalSale]),
      'koc-cari': JSON.stringify({ name: 'Özer Koç', address: 'İstanbul', balance: 24.5 }),
      'koc-padding': 'x'.repeat(4096)
    }));
    const originalProducts = persisted.get('koc-prods');
    const originalCari = persisted.get('koc-cari');
    for (let cycle = 1; cycle <= 5; cycle++) {
      const boot = {
        engine: 'sqlite', report: { warnings: ['Türkçe aktarım testi ✅'] },
        data: Object.fromEntries(persisted)
      };
      const generated = spawnSync(exe, [], { input: JSON.stringify(boot), maxBuffer: 8 * 1024 * 1024 });
      assert.ifError(generated.error);
      assert.equal(generated.status, 0, generated.stderr.toString());
      const utf8 = generated.stdout.toString('utf8');
      assert.ok(Buffer.byteLength(utf8.slice(0, utf8.indexOf('<meta charset="UTF-8">') + 22)) < 1024);
      assert.ok(utf8.indexOf('<meta charset="UTF-8">') < utf8.indexOf('window.__KOC_BOOT__'));
      // En kötü durumda bile açılış verisi ve köprü bozulamaz.
      const decoded = new TextDecoder('windows-1252').decode(generated.stdout);
      const scripts = [...decoded.matchAll(/<script>([\s\S]*?)<\/script>/g)].slice(0, 3);
      assert.equal(scripts.length, 3);
      const { context, window } = bridgeContext(persisted);
      for (const script of scripts) {
        assert.match(script[1], /^[\x00-\x7f]*$/);
        vm.runInContext(script[1], context);
      }
      assert.equal(window.kocStore.read('koc-prods'), originalProducts);
      assert.equal(window.kocStore.read('koc-cari'), originalCari);
      const sales = JSON.parse(window.kocStore.read('koc-sales'));
      assert.deepEqual(sales[0], originalSale);
      assert.equal(sales.length, cycle);
      sales.push({ id: `yeni-satis-${cycle}`, items: products, total: 24.5 });
      window.kocStore.write('koc-prods', window.kocStore.read('koc-prods'));
      window.kocStore.write('koc-sales', JSON.stringify(sales));
      assert.equal(await window.kocApp.flush(), true);
      assert.equal(window.kocApp.pendingWrites(), 0);
    }
    assert.equal(JSON.parse(persisted.get('koc-sales')).length, 6);
    assert.equal(persisted.get('koc-prods'), originalProducts);
    assert.equal(persisted.get('koc-cari'), originalCari);
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});
