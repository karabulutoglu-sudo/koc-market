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

test('geçmiş listesi ve grafik her dönemin ilk ve son günü için eşleşir', () => {
  const windowDate = new Date(2026, 10, 27, 18);
  const state = vm.createContext({ windowDate, sales: [], assert });
  vm.runInContext([
    'saleTimestamp', 'getSalesPeriod', 'getFilteredSales', 'getChartBuckets'
  ].map(appFunction).join('\n'), state);
  for (const filter of ['today', 'week', 'month', '3months', '6months', 'year']) {
    state.filter = filter;
    vm.runInContext(`{
      const period = getSalesPeriod(filter, windowDate);
      const first = new Date(period.start); first.setHours(15);
      const last = period.end.getTime() - 1;
      sales = [
        { id: first.getTime(), total: 100 },
        { id: 'new-id', at: new Date(last).toISOString(), total: 55 },
        { id: 'before', at: period.start.getTime() - 1, total: 999 },
        { id: 'after', at: period.end.getTime(), total: 999 }
      ];
      const list = getFilteredSales(period);
      const graph = getChartBuckets(list, period);
      assert.equal(list.length, 2, filter);
      assert.equal(graph.reduce((sum, b) => sum + b.count, 0), 2, filter);
      assert.equal(graph.reduce((sum, b) => sum + b.ciro, 0), 155, filter);
      if (filter === 'week') assert.equal(graph.length, 7);
      if (filter === 'month') assert.equal(graph.length, 30);
    }`, state);
  }
  assert.equal(vm.runInContext("saleTimestamp({ id: 'legacy', d: '27.11.2026 14:15:16' })", state),
    new Date(2026, 10, 27, 14, 15, 16).getTime());
});

test('geçmiş satırı ismi metin olarak gösterir ve fişi ID ile açar', () => {
  const elements = {};
  const sale = { id: 'sale-1', d: '27.11.2026', items: [{ n: "Lay's <Patates>" }], total: 15 };
  let opened;
  const state = vm.createContext({
    document: { getElementById(id) { return elements[id] ||= {}; } }, histFilter: 'today',
    getSalesPeriod: () => ({}), getFilteredSales: () => [sale], renderHistChart() {},
    fmt: String, showReceipt(s) { opened = s; }
  });
  vm.runInContext([appFunction('escHtml'), appFunction('renderHistory'), 'renderHistory()'].join('\n'), state);
  const rendered = elements.histList.innerHTML;
  assert.match(rendered, /<button[^>]*data-sale-id="sale-1"/);
  assert.match(rendered, /Lay&#39;s &lt;Patates&gt;/);
  assert.doesNotMatch(rendered, /onclick=/);
  elements.histList.onclick({ target: { closest: () => ({ dataset: { saleId: 'sale-1', saleIndex: '0' } }) } });
  assert.equal(opened, sale);
});

test('üst kategori kimliğiyle seçildiğinde derin alt dallar ve eski kategori adları görünür', () => {
  const categories = [
    { id: 'a', name: 'Atıştırmalık' }, { id: 'k', name: 'Kraker', parentId: 'a' },
    { id: 's', name: 'Sade', parentId: 'k' }, { id: 'i', name: 'İçecek' }
  ];
  const products = [
    { b: '1', c: 'Atıştırmalık', cid: 'a' }, { b: '2', c: 'Kraker', cid: 'k' },
    { b: '3', c: 'Sade' }, { b: '4', c: 'Kraker', cid: 'i' }
  ];
  const state = vm.createContext({ products, _activeCategories: () => categories });
  vm.runInContext([appFunction('_categoryDescendantIds'), appFunction('productsInCategory')].join('\n'), state);
  const included = vm.runInContext("productsInCategory('Atıştırmalık').map(p => p.b).join(',')", state);
  assert.equal(included, '1,2,3');
});

test('yeni arayüz betiği PDF.js tek kopya yükler ve XLSX betiğine başvurmaz', () => {
  assert.match(html, /await import\('\.\/pdf-loader\.mjs'\)/);
  assert.doesNotMatch(html, /<script src="https?:\/\//);
  assert.doesNotMatch(html, /<script src="[^"\n]*xlsx/i);
});
