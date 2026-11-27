const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const bridge = fs.readFileSync(path.join(__dirname, '../src-tauri/src/bridge.js'), 'utf8');
const marker = 'koc-atomic-last-operation';

function setup(invoke = async () => {}, bootData = {}) {
  const calls = [], timers = new Map(), warning = [];
  let now = 0, timerId = 0, reloads = 0;
  const window = {
    __KOC_BOOT__: { data: bootData, engine: 'SQLite' },
    __TAURI_INTERNALS__: {
      invoke(command, args) {
        calls.push({ command, args });
        return invoke(command, args);
      }
    },
    addEventListener() {}
  };
  vm.runInNewContext(bridge, { window, location: { reload() { reloads++; } }, console: { error() {} },
    document: {
      createElement() { return { style: {}, remove() {}, set textContent(text) { warning.push(text); } }; },
      body: { appendChild() {} }
    },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, at: now + delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  });
  function advance(ms) {
    now += ms;
    for (const [id, timer] of timers) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.fn();
    }
  }
  return { advance, calls, warning, window, reloads: () => reloads };
}

const settle = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('ordinary writes precede one acknowledged transaction for stock, receipt and credit', async () => {
  const oldWrite = deferred(), diskWrite = deferred();
  let writes = 0;
  const s = setup(() => (++writes === 1 ? oldWrite.promise : diskWrite.promise), { 'koc-prods': '10' });
  s.window.kocStore.write('koc-settings', 'new setting');
  const sale = s.window.kocStore.commit('sale-id', {
    'koc-prods': '9', 'koc-sales': '["sale-id"]', 'koc-cari-state': '{"saleId":"sale-id"}'
  });
  assert.equal(s.calls.length, 1);
  assert.equal(s.window.kocStore.read('koc-prods'), '10');
  await assert.rejects(s.window.kocStore.commit('other-transaction', { 'koc-prods': '0' }), /Toplu kayıt/);
  assert.throws(() => s.window.kocStore.write('koc-prods', '3'), /Toplu kayıt/);
  assert.equal(s.window.kocStore.commit('sale-id', { 'koc-prods': '8' }), sale);

  oldWrite.resolve();
  await settle();
  assert.equal(s.calls.length, 2);
  const ops = JSON.parse(JSON.stringify(s.calls[1].args.ops));
  assert.deepEqual(ops.map(op => op.key), ['koc-prods', 'koc-sales', 'koc-cari-state', marker]);
  assert.equal(ops[3].val, 'sale-id');
  assert.equal(s.window.kocStore.read('koc-sales'), null);

  diskWrite.resolve();
  assert.equal((await sale).alreadyCommitted, false);
  assert.equal(s.window.kocStore.read('koc-prods'), '9');
  assert.equal(s.window.kocStore.read('koc-sales'), '["sale-id"]');
  assert.equal(s.window.kocStore.read('koc-cari-state'), '{"saleId":"sale-id"}');
  assert.equal((await s.window.kocStore.commit('sale-id', { 'koc-prods': '8' })).alreadyCommitted, true);
  assert.equal(s.calls.length, 2);
});

test('reopening reads the last transaction marker and prevents repeating it', async () => {
  const s = setup(async () => assert.fail('no duplicate disk write'), { 'koc-prods': '9', [marker]: 'sale-id' });
  assert.equal((await s.window.kocStore.commit('sale-id', { 'koc-prods': '8' })).alreadyCommitted, true);
  assert.equal(s.window.kocStore.read('koc-prods'), '9');
  assert.throws(() => s.window.kocStore.remove(marker), /İşlem kimliği/);
});

test('failed native transaction keeps old data and blocks transitions until a successful retry', async () => {
  let writes = 0;
  const s = setup(async command => { if (command === 'kv_apply' && ++writes === 1) throw new Error('disk busy'); },
    { 'koc-prods': '10', 'koc-old': 'keep' });
  const changes = { 'koc-prods': '9', 'koc-old': null };
  await assert.rejects(s.window.kocStore.commit('sale-id', changes), /disk busy/);
  assert.equal(s.window.kocStore.read('koc-prods'), '10');
  assert.equal(s.window.kocStore.read('koc-old'), 'keep');
  assert.equal(s.window.kocStore.read(marker), null);
  assert.equal(await s.window.__kocReload(), false);
  assert.equal(await s.window.__kocFlushAndClose(1), false);
  assert.equal(s.reloads(), 0);
  assert.deepEqual(s.calls.map(call => call.command), ['kv_apply', 'flush_blocked']);
  assert.equal(s.calls.at(-1).args.generation, 1);
  assert.equal(s.calls.at(-1).args.reason, 'write_failed');
  assert.match(s.warning.join('\n'), /diske yazılamadı/);

  assert.equal((await s.window.kocStore.commit('sale-id', changes)).alreadyCommitted, false);
  assert.equal(s.window.kocStore.read('koc-prods'), '9');
  assert.equal(s.window.kocStore.read('koc-old'), null);
  assert.equal(await s.window.__kocFlushAndClose(2), true);
  assert.equal(s.calls.at(-1).command, 'flush_done');
  assert.equal(s.calls.at(-1).args.generation, 2);
});

test('reload and close timeouts with a delayed write never tell native code the data is ready', async () => {
  const diskWrite = deferred();
  const s = setup(command => command === 'kv_apply' ? diskWrite.promise : Promise.resolve());
  s.window.kocStore.write('koc-sales', '["sale-id"]');
  const reload = s.window.__kocReload();
  s.advance(7000);
  assert.equal(await reload, false);
  assert.equal(s.reloads(), 0);
  const close = s.window.__kocFlushAndClose(11);
  s.advance(7000);
  assert.equal(await close, false);
  assert.deepEqual(s.calls.map(x => x.command), ['kv_apply', 'flush_blocked']);
  assert.equal(s.calls.at(-1).args.generation, 11);
  assert.equal(s.calls.at(-1).args.reason, 'pending');
  assert.equal(s.window.kocApp.pendingWrites(), 1);

  diskWrite.resolve();
  assert.equal(await s.window.__kocReload(), true);
  assert.equal(s.reloads(), 1);
  assert.equal(await s.window.__kocFlushAndClose(12), true);
  assert.deepEqual(s.calls.map(x => x.command), ['kv_apply', 'flush_blocked', 'flush_done']);
  assert.equal(s.calls.at(-1).args.generation, 12);
});

test('closing waits for an in-flight sale and prevents other writes before the acknowledgement', async () => {
  const diskWrite = deferred();
  const s = setup(command => command === 'kv_apply' ? diskWrite.promise : Promise.resolve());
  const sale = s.window.kocStore.commit('sale-id', { 'koc-sales': '["sale-id"]' });
  const close = s.window.__kocFlushAndClose(4);
  await settle();
  assert.deepEqual(s.calls.map(x => x.command), ['kv_apply']);
  assert.throws(() => s.window.kocStore.write('koc-sales', '[]'), /kapanış/);
  diskWrite.resolve();
  await sale;
  assert.equal(await close, true);
  assert.deepEqual(s.calls.map(x => x.command), ['kv_apply', 'flush_done']);
  assert.equal(s.calls.at(-1).args.generation, 4);
  assert.throws(() => s.window.kocStore.write('koc-sales', '[]'), /kapanış/);
});

test('a busy or obsolete native close acknowledgement leaves the next retry available', async () => {
  const s = setup(async (command, args) => {
    if (command === 'flush_done') return args.generation === 2;
  });
  assert.equal(await s.window.__kocFlushAndClose(1), false);
  assert.equal(s.window.kocStore.write('koc-sales', '[]'), true);
  assert.equal(await s.window.__kocFlushAndClose(2), true);
  assert.deepEqual(s.calls.map(x => x.command), ['flush_done', 'kv_apply', 'flush_done']);
});
