const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src-tauri/src/repair-ui.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(overrides = {}, loading = false) {
  const listeners = {};
  const calls = { preview: 0, apply: [], cancel: 0, reload: 0, hint: 0 };
  const document = { readyState: loading ? 'loading' : 'complete', activeElement: null };
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attributes = {};
      this.listeners = {};
      this.disabled = false;
      this.hidden = false;
      this.inert = false;
      this._text = '';
    }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(value) { throw new Error('UI must never parse HTML: ' + value); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return Object.hasOwn(this.attributes, key) ? this.attributes[key] : null; }
    removeAttribute(key) { delete this.attributes[key]; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    replaceChildren(...children) {
      this.children.forEach(child => { child.parentNode = null; });
      this.children = [];
      this._text = '';
      children.forEach(child => this.appendChild(child));
    }
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
      this.parentNode = null;
    }
    contains(target) { return target === this || this.children.some(child => child.contains(target)); }
    get isConnected() { return this === document.body || this === document.head || !!this.parentNode?.isConnected; }
    focus() { document.activeElement = this; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    click() { if (!this.disabled) (this.listeners.click || []).forEach(fn => fn({ type: 'click', target: this })); }
  }
  document.head = new Element('head');
  document.body = new Element('body');
  document.createElement = tag => new Element(tag);
  document.addEventListener = (type, fn, options) => (listeners['document:' + type] ||= []).push({ fn, once: options?.once });
  document.body.appendChild(new Element('input'));
  const background = document.body.children[0];
  background.setAttribute('aria-hidden', 'false');
  background.focus();
  const defaultPreview = {
    changes: 2, product_changes: 1, sale_changes: 1, other_changes: 0, unresolved: 0,
    samples: [{ scope: 'product', path: 'koc-prods[0].n', before: 'ÃœLKER', after: 'ÜLKER', layers: 1 }],
    token: 'preview-token', backup_path: 'C:\\Backup\\before-repair.db'
  };
  const api = {
    hasEncodingDamage() { calls.hint++; return true; },
    async previewEncodingRepair() { calls.preview++; return overrides.preview ? overrides.preview() : defaultPreview; },
    async applyEncodingRepair(token) { calls.apply.push(token); return overrides.apply ? overrides.apply(token) : { changes: 2 }; },
    async cancelEncodingRepair() { calls.cancel++; return overrides.cancel ? overrides.cancel() : undefined; }
  };
  const window = {
    kocApp: api,
    location: { reload() { calls.reload++; if (overrides.reload) overrides.reload(); } },
    addEventListener(type, fn) { (listeners['window:' + type] ||= []).push({ fn }); }
  };
  const context = vm.createContext({ window, document, console });
  const run = () => vm.runInContext(source, context);
  const all = () => {
    const result = [];
    function visit(node) { result.push(node); node.children.forEach(visit); }
    visit(document.body);
    return result;
  };
  const byId = id => all().find(node => node.id === id);
  const button = label => all().find(node => node.tagName === 'BUTTON' && node.textContent === label);
  function dispatch(surface, type, options = {}) {
    const event = {
      type, target: options.target || document.activeElement, ...options, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; }
    };
    const key = surface + ':' + type;
    for (const listener of [...(listeners[key] || [])]) {
      listener.fn(event);
      if (listener.once) listeners[key] = listeners[key].filter(item => item !== listener);
      if (event.stopped) break;
    }
    return event;
  }
  run();
  return { calls, document, window, defaultPreview, background, all, byId, button, dispatch, run };
}

test('startup displays repair button without backup, preview or automatic repair', () => {
  const h = harness();
  assert.ok(h.button('Türkçe Adları Onar'));
  assert.match(h.button('Türkçe Adları Onar').className, /attention/);
  assert.equal(h.calls.hint, 1);
  assert.equal(h.calls.preview, 0);
  assert.equal(h.calls.cancel, 0);
  assert.deepEqual(h.calls.apply, []);
  assert.equal(h.byId('koc-encoding-overlay'), undefined);
});

test('DOMContentLoaded installs once even if injected twice', () => {
  const h = harness({}, true);
  assert.equal(h.button('Türkçe Adları Onar'), undefined);
  h.run();
  h.dispatch('document', 'DOMContentLoaded');
  h.dispatch('document', 'DOMContentLoaded');
  assert.equal(h.all().filter(node => node.id === 'koc-encoding-launch').length, 1);
  assert.equal(h.calls.preview, 0);
});

test('preview shows real backup and samples; only explicit confirmation applies and reloads', async () => {
  const h = harness();
  h.button('Türkçe Adları Onar').click();
  await tick();
  const text = h.byId('koc-encoding-dialog').textContent;
  assert.ok(text.includes(h.defaultPreview.backup_path));
  assert.ok(text.includes('Ürün yazısı: 1'));
  assert.ok(text.includes('ÃœLKER'));
  assert.ok(text.includes('ÜLKER'));
  assert.equal(h.background.inert, true);
  assert.equal(h.document.activeElement, h.button('Şimdi Değil'));
  assert.deepEqual(h.calls.apply, []);
  h.button('Onar ve Yenile').click();
  await tick();
  assert.deepEqual(h.calls.apply, ['preview-token']);
  assert.equal(h.calls.reload, 1);
});

test('sample text, path and backup path are rendered inert without HTML interpretation', async () => {
  const payload = '<img src=x onerror="window.pwned=1"><script>evil()</script>';
  const h = harness({ preview: () => ({
    changes: 1, product_changes: 1, sale_changes: 0, other_changes: 0, unresolved: 2,
    samples: [{ scope: payload, path: payload, before: payload, after: payload }],
    token: 'safe-token', backup_path: payload
  }) });
  h.button('Türkçe Adları Onar').click();
  await tick();
  assert.ok(h.byId('koc-encoding-dialog').textContent.includes(payload));
  assert.ok(h.byId('koc-encoding-dialog').textContent.includes('çözülemeyen 2 metin'));
  assert.equal(h.all().some(node => node.tagName === 'IMG' || node.tagName === 'SCRIPT'), false);
  assert.equal(h.window.pwned, undefined);
  assert.deepEqual(h.calls.apply, []);
});

test('backup failure keeps modal and confirmation disabled; retry resets native pending state', async () => {
  let attempts = 0;
  const h = harness({ preview: () => {
    if (++attempts === 1) throw new Error('Yedek oluşturulamadı');
    return h.defaultPreview;
  } });
  h.button('Türkçe Adları Onar').click();
  await tick();
  assert.match(h.byId('koc-encoding-dialog').textContent, /Yedek oluşturulamadı/);
  assert.equal(h.button('Onar ve Yenile').disabled, true);
  h.button('Onar ve Yenile').click();
  assert.deepEqual(h.calls.apply, []);
  h.button('Tekrar Dene').click();
  await tick();
  assert.equal(h.calls.cancel, 1);
  assert.equal(h.calls.preview, 2);
  assert.equal(h.button('Onar ve Yenile').disabled, false);
  assert.deepEqual(h.calls.apply, []);
});

test('missing backup proof or token never enables apply', async () => {
  for (const field of ['backup_path', 'token']) {
    const h = harness({ preview: () => ({ ...h.defaultPreview, [field]: '' }) });
    h.button('Türkçe Adları Onar').click();
    await tick();
    assert.equal(h.button('Onar ve Yenile').disabled, true);
    h.button('Onar ve Yenile').click();
    assert.deepEqual(h.calls.apply, []);
    assert.match(h.byId('koc-encoding-dialog').textContent, /Yedek ve önizleme doğrulanamadı/);
  }
});

test('cancel invokes native reset and restores focus and background accessibility', async () => {
  const h = harness();
  h.button('Türkçe Adları Onar').click();
  await tick();
  h.button('Şimdi Değil').click();
  await tick();
  assert.equal(h.calls.cancel, 1);
  assert.equal(h.byId('koc-encoding-overlay'), undefined);
  assert.equal(h.background.inert, false);
  assert.equal(h.background.getAttribute('aria-hidden'), 'false');
  assert.equal(h.document.activeElement, h.background);
  assert.deepEqual(h.calls.apply, []);
});

test('Escape during preview waits for native preview before cancelling, without applying late result', async () => {
  const pending = deferred();
  const h = harness({ preview: () => pending.promise });
  h.button('Türkçe Adları Onar').click();
  const event = h.dispatch('window', 'keydown', { key: 'Escape' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.stopped, true);
  await tick();
  assert.equal(h.calls.cancel, 0);
  assert.equal(h.button('Onar ve Yenile').disabled, true);
  pending.resolve(h.defaultPreview);
  await tick();
  assert.equal(h.calls.cancel, 1);
  assert.equal(h.byId('koc-encoding-overlay'), undefined);
  assert.deepEqual(h.calls.apply, []);
});

test('double clicks run one preview and one apply; applying cannot be cancelled', async () => {
  const pendingPreview = deferred();
  const pendingApply = deferred();
  const h = harness({ preview: () => pendingPreview.promise, apply: () => pendingApply.promise });
  h.button('Türkçe Adları Onar').click();
  h.button('Türkçe Adları Onar').click();
  assert.equal(h.calls.preview, 1);
  pendingPreview.resolve(h.defaultPreview);
  await tick();
  h.button('Onar ve Yenile').click();
  h.button('Onar ve Yenile').click();
  h.dispatch('window', 'keydown', { key: 'Escape' });
  await tick();
  assert.deepEqual(h.calls.apply, ['preview-token']);
  assert.equal(h.calls.cancel, 0);
  assert.equal(h.calls.reload, 0);
  pendingApply.resolve({ changes: 2 });
  await tick();
  assert.equal(h.calls.reload, 1);
});

test('modal intercepts scanner and sale shortcut keys; Tab cycles only modal buttons', async () => {
  const h = harness();
  h.button('Türkçe Adları Onar').click();
  await tick();
  for (const type of ['keydown', 'keypress', 'keyup']) {
    const event = h.dispatch('window', type, { key: '8', target: h.background });
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.stopped, true);
  }
  const refresh = h.dispatch('window', 'keydown', { key: 'F5', target: h.background });
  assert.equal(refresh.defaultPrevented, true);
  assert.equal(refresh.stopped, true);
  h.dispatch('window', 'keydown', { key: 'Tab' });
  assert.equal(h.document.activeElement, h.button('Onar ve Yenile'));
  h.dispatch('window', 'keydown', { key: 'Tab' });
  assert.equal(h.document.activeElement, h.button('Şimdi Değil'));
  h.dispatch('window', 'keydown', { key: 'Tab', shiftKey: true });
  assert.equal(h.document.activeElement, h.button('Onar ve Yenile'));
  assert.equal(h.calls.reload, 0);
});

test('apply failure requires fresh preview and cannot reuse a failed token', async () => {
  const h = harness({ apply: () => { throw new Error('Veri değişti; yeniden önizleme alın'); } });
  h.button('Türkçe Adları Onar').click();
  await tick();
  h.button('Onar ve Yenile').click();
  await tick();
  assert.equal(h.button('Onar ve Yenile').disabled, true);
  h.button('Onar ve Yenile').click();
  assert.deepEqual(h.calls.apply, ['preview-token']);
  assert.equal(h.calls.reload, 0);
  h.button('Tekrar Dene').click();
  await tick();
  assert.equal(h.calls.cancel, 1);
  assert.equal(h.calls.preview, 2);
  assert.equal(h.button('Onar ve Yenile').disabled, false);
});

test('failed cancel retains interaction lock and retry closes only after native reset succeeds', async () => {
  let attempts = 0;
  const h = harness({ cancel: () => { if (++attempts === 1) throw new Error('Geçici hata'); } });
  h.button('Türkçe Adları Onar').click();
  await tick();
  h.button('Şimdi Değil').click();
  await tick();
  assert.ok(h.byId('koc-encoding-overlay'));
  assert.equal(h.background.inert, true);
  assert.equal(h.button('Onar ve Yenile').disabled, true);
  h.button('Tekrar Dene').click();
  await tick();
  assert.equal(h.calls.cancel, 2);
  assert.equal(h.calls.preview, 1);
  assert.equal(h.byId('koc-encoding-overlay'), undefined);
});

test('zero-change preview shows backup but cannot apply', async () => {
  const h = harness({ preview: () => ({ ...h.defaultPreview, changes: 0, product_changes: 0, sale_changes: 0, token: null, samples: [] }) });
  h.button('Türkçe Adları Onar').click();
  await tick();
  assert.ok(h.byId('koc-encoding-dialog').textContent.includes('Onarılacak kayıt bulunamadı.'));
  assert.ok(h.byId('koc-encoding-dialog').textContent.includes(h.defaultPreview.backup_path));
  assert.equal(h.button('Onar ve Yenile').disabled, true);
  assert.deepEqual(h.calls.apply, []);
});

test('zero changes with unresolved damage explains repair limitation and never claims clean data', async () => {
  const h = harness({ preview: () => ({ ...h.defaultPreview, changes: 0, product_changes: 0, sale_changes: 0, unresolved: 32265, token: null, samples: [] }) });
  h.button('Türkçe Adları Onar').click();
  await tick();
  const text = h.byId('koc-encoding-dialog').textContent;
  assert.ok(text.includes('32265 metin bulundu'));
  assert.ok(text.includes('güvenli biçimde onarılamadı'));
  assert.ok(text.includes('Sorun devam ediyor. Hiçbir kayıt değiştirilmedi'));
  assert.ok(text.includes(h.defaultPreview.backup_path));
  assert.equal(text.includes('Onarılacak kayıt bulunamadı.'), false);
  assert.equal(h.button('Onar ve Yenile').disabled, true);
  h.button('Onar ve Yenile').click();
  assert.deepEqual(h.calls.apply, []);
  assert.equal(h.calls.reload, 0);
});

test('reload failure after success cannot cancel back into stale application data', async () => {
  let attempts = 0;
  const h = harness({ reload: () => { if (++attempts === 1) throw new Error('Yenileme denenmeli'); } });
  h.button('Türkçe Adları Onar').click();
  await tick();
  h.button('Onar ve Yenile').click();
  await tick();
  assert.equal(h.button('Şimdi Değil').disabled, true);
  assert.equal(h.button('Onar ve Yenile').disabled, true);
  h.button('Uygulamayı Yenile').click();
  assert.equal(h.calls.reload, 2);
  assert.equal(h.calls.cancel, 0);
  assert.deepEqual(h.calls.apply, ['preview-token']);
});
