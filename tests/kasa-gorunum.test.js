const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function appFunction(name) {
  const code = html.match(new RegExp(`^function ${name}\\([^\\n]*\\n[\\s\\S]*?^}`, 'm'));
  assert.ok(code, name);
  return code[0];
}

test('kasaGorunumTercihi geçersiz veya hatalı depolamada otomatik döner', () => {
  const storageValues = { value: 'xyz', throwOnRead: false };
  const ctx = vm.createContext({
    KASA_GORUNUMLERI: ['otomatik', 'masaustu', 'dokunmatik'],
    window: {
      localStorage: {
        getItem() {
          if (storageValues.throwOnRead) throw new Error('Depo erişilemiyor');
          return storageValues.value;
        }
      }
    }
  });
  vm.runInContext(
    ['KASA_GORUNUM_KEY = "koc-ui-kasa-gorunum"', appFunction('kasaGorunumTercihi')].join(';\n'),
    ctx
  );

  assert.equal(ctx.kasaGorunumTercihi(), 'otomatik');
  storageValues.value = 'dokunmatik';
  assert.equal(ctx.kasaGorunumTercihi(), 'dokunmatik');
  storageValues.throwOnRead = true;
  assert.equal(ctx.kasaGorunumTercihi(), 'otomatik');
});

test('kasaDokunmatikAlgila ve kasaEtkinGorunum fare takılı dokunmatik Windows dahil doğru mod seçer', () => {
  const ctx = vm.createContext({
    KASA_GORUNUMLERI: ['otomatik', 'masaustu', 'dokunmatik'],
    window: {
      matchMedia: () => ({ matches: false }),
      localStorage: { getItem: () => 'otomatik' }
    },
    navigator: { maxTouchPoints: 5 }
  });
  vm.runInContext(
    [
      'KASA_GORUNUM_KEY = "koc-ui-kasa-gorunum"',
      appFunction('kasaGorunumTercihi'),
      appFunction('kasaDokunmatikAlgila'),
      appFunction('kasaEtkinGorunum')
    ].join('\n'),
    ctx
  );

  assert.equal(ctx.kasaDokunmatikAlgila(), true);
  assert.equal(ctx.kasaEtkinGorunum(), 'dokunmatik');
  assert.equal(ctx.kasaEtkinGorunum('masaustu'), 'masaustu');

  ctx.navigator.maxTouchPoints = 0;
  assert.equal(ctx.kasaDokunmatikAlgila(), false);
  assert.equal(ctx.kasaEtkinGorunum(), 'masaustu');
});

test('kasaGorunumKilitli sepet doluyken veya ödeme açıkken değişimi engeller', () => {
  const ctx = vm.createContext({ cart: [], paying: false });
  vm.runInContext(appFunction('kasaGorunumKilitli'), ctx);

  assert.equal(ctx.kasaGorunumKilitli(), false);
  ctx.cart = [{}];
  assert.equal(ctx.kasaGorunumKilitli(), true);
  ctx.cart = [];
  ctx.paying = true;
  assert.equal(ctx.kasaGorunumKilitli(), true);
});

test('index.html Yayın 2 palet, ray oturum denetimi, hibrit kasa ve prova sözleşmelerini korur', () => {
  const lockPos = html.indexOf('id="lockBtn"');
  const tabsPos = html.indexOf('<!-- Tabs -->');
  assert.ok(lockPos !== -1 && tabsPos !== -1 && lockPos < tabsPos, 'lockBtn rayda ve sekmelerden önce olmalı');
  assert.equal(html.match(/id="lockBtn"/g)?.length, 1, 'id="lockBtn" tam olarak bir kez geçmeli');

  for (const snippet of [
    'data-pane="kasa"',
    'data-pay-method="cash"',
    'data-pay-method="card"',
    'data-pay-method="cari"',
    'id="cardPosApproved"',
    '--accent:#008977',
    '#0A2031',
    '(any-pointer: coarse)',
    'class="btn-pay"',
    'pay-method cash',
    'pay-method account',
    'id="payInput"',
    'btn-finish',
    'cari-pay-row'
  ]) {
    assert.ok(html.includes(snippet), `Eksik sözleşme: ${snippet}`);
  }

  assert.equal([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].length, 1, 'Tek inline script korunmalı');
});
