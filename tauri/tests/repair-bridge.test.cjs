const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const bridge = fs.readFileSync(path.join(__dirname, '../src-tauri/src/bridge.js'), 'utf8');
function setup(handler = async () => {}, globals = '') {
  const calls = [], events = {};
  let reloads = 0;
  const window = {
    __KOC_BOOT__: { engine: 'sqlite', data: { 'koc-prods': '[{"b":"123","n":"ÃœLKER","p":40}]' }, report: {} },
    __TAURI_INTERNALS__: { async invoke(cmd, args) { calls.push({ cmd, args }); return handler(cmd, args); } },
    addEventListener(name, fn) { events[name] = fn; }
  };
  const context = vm.createContext({ window, location: { reload() { reloads++; } },
    document: { body: null, addEventListener() {} }, setTimeout() {}, console });
  if (globals) vm.runInContext(globals, context);
  vm.runInContext(bridge, context);
  return { window, calls, events, context, reloads: () => reloads };
}
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }

test('repair preview drains earlier sales before requesting the native snapshot', async () => {
  const write = deferred();
  const s = setup(cmd => cmd === 'kv_apply' ? write.promise : { token: 'shown' });
  s.window.kocStore.write('koc-sales', '[{"id":"new-sale","total":40}]');
  const preview = s.window.kocApp.previewEncodingRepair();
  assert.deepEqual(s.calls.map(x => x.cmd), ['kv_apply']);
  const original = s.window.kocStore.read('koc-prods');
  assert.throws(() => s.window.kocStore.write('koc-prods', 'stale'), /önizlemesi/);
  assert.throws(() => s.window.kocStore.remove('koc-prods'), /önizlemesi/);
  assert.equal(s.window.kocStore.read('koc-prods'), original);
  write.resolve();
  await preview;
  assert.deepEqual(s.calls.map(x => x.cmd), ['kv_apply', 'encoding_repair_preview']);
});

test('apply sends only the shown token and remains locked until page reload', async () => {
  const s = setup(async () => ({ token: 'preview-token' }));
  await s.window.kocApp.previewEncodingRepair();
  await assert.rejects(s.window.kocApp.previewEncodingRepair(), /zaten açık/);
  await s.window.kocApp.applyEncodingRepair('preview-token');
  const call = s.calls.find(x => x.cmd === 'encoding_repair_apply');
  assert.equal(JSON.stringify(call.args), '{"token":"preview-token"}');
  assert.throws(() => s.window.kocDB.set('koc-prods', 'stale'), /önizlemesi/);
  await s.window.__kocReload();
  assert.equal(s.reloads(), 0);
});

test('cancel unlocks writes only after native cancellation completes', async () => {
  const cancelled = deferred();
  const s = setup(cmd => cmd === 'encoding_repair_cancel' ? cancelled.promise : {});
  await s.window.kocApp.previewEncodingRepair();
  const closing = s.window.kocApp.cancelEncodingRepair();
  assert.throws(() => s.window.kocStore.write('setting', '1'), /önizlemesi/);
  cancelled.resolve(); await closing;
  s.window.kocStore.write('setting', '1');
  assert.equal(await s.window.kocApp.flush(), true);
});

test('failed cancellation retains the lock and can be retried', async () => {
  let attempts = 0;
  const s = setup(async cmd => { if (cmd === 'encoding_repair_cancel' && ++attempts === 1) throw new Error('busy'); });
  await s.window.kocApp.previewEncodingRepair();
  await assert.rejects(s.window.kocApp.cancelEncodingRepair(), /busy/);
  assert.throws(() => s.window.kocStore.write('setting', '1'), /önizlemesi/);
  await s.window.kocApp.cancelEncodingRepair();
  s.window.kocStore.write('setting', '1');
});

test('failed preview cancels the native plan before unlocking', async () => {
  const s = setup(async cmd => { if (cmd === 'encoding_repair_preview') throw new Error('backup failed'); });
  await assert.rejects(s.window.kocApp.previewEncodingRepair(), /backup failed/);
  assert.deepEqual(s.calls.map(x => x.cmd), ['encoding_repair_preview', 'encoding_repair_cancel']);
  s.window.kocStore.write('setting', '1');
});

test('unfinished cart and payment reject repair without freezing or native calls', async () => {
  for (const globals of ['let cart = [{b:"123"}]; let paying = false;', 'let cart = []; let paying = true;']) {
    const s = setup(undefined, globals);
    await assert.rejects(s.window.kocApp.previewEncodingRepair(), /açık satışı/);
    assert.equal(s.calls.length, 0);
    s.window.kocStore.write('setting', '1');
  }
});

test('apply without a preview never invokes native repair', async () => {
  const s = setup();
  await assert.rejects(s.window.kocApp.applyEncodingRepair('invented'), /Önce onarım/);
  assert.equal(s.calls.length, 0);
});

test('refresh shortcuts cannot reload during repair preview', async () => {
  const s = setup();
  await s.window.kocApp.previewEncodingRepair();
  let prevented = 0;
  for (const key of ['F5', 'r', 'R']) s.events.keydown({ key, ctrlKey: true,
    preventDefault() { prevented++; }, stopPropagation() {} });
  assert.equal(prevented, 3);
  assert.equal(s.reloads(), 0);
});
