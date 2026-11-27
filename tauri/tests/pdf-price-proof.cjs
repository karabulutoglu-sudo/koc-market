const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const tauriDir = path.resolve(__dirname, '..');
const prepared = path.join(tauriDir,'dist-web');

function makePricePdf() {
  const stream = 'BT /F1 12 Tf 40 740 Td (8699991234567) Tj 180 0 Td (25,50 TL) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + 'endstream'
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj,index) => {
    offsets.push(Buffer.byteLength(text));
    text += (index+1) + ' 0 obj\n' + obj + '\nendobj\n';
  });
  const xref = Buffer.byteLength(text);
  text += 'xref\n0 6\n0000000000 65535 f \n';
  for (const pos of offsets.slice(1)) text += String(pos).padStart(10,'0') + ' 00000 n \n';
  text += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(text,'ascii');
}

test('paketlenen yerel PDF.js metinli fiyat listesinden barkod ve fiyatı çıkarır', async () => {
  const {openPricePdf} = await import(pathToFileURL(path.join(prepared,'pdf-loader.mjs')).href);
  const task = openPricePdf(makePricePdf());
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const {items: runs} = await page.getTextContent();
    const items = runs.filter(r => r.str?.trim()).map(r => ({
      page:1, x:r.transform[4], y:r.transform[5], text:r.str.trim()
    }));
    const app = fs.readFileSync(path.join(prepared,'app.js'),'utf8');
    const context = vm.createContext({});
    for (const name of ['parsePrice','extractBarcodePricePairs']) {
      const source = app.match(new RegExp('^function ' + name + '\\([^\\n]*[\\s\\S]*?^}', 'm'))?.[0];
      assert.ok(source, name);
      vm.runInContext(source, context);
    }
    const pairs = context.extractBarcodePricePairs(items, items.map(item => item.text).join(' '));
    assert.equal(pairs.length,1);
    assert.equal(pairs[0].barcode,'8699991234567');
    assert.equal(pairs[0].pdfPrice,25.50);
  } finally {
    await task.destroy();
  }
});

test('derlenen HTML yerel betikleri ve CSP dış ağ kısıtını kullanır', () => {
  const html = fs.readFileSync(path.join(prepared,'index.html'),'utf8');
  const app = fs.readFileSync(path.join(prepared,'app.js'),'utf8');
  const csp = JSON.parse(fs.readFileSync(path.join(tauriDir,'src-tauri','tauri.conf.json'),'utf8')).app.security.csp;
  assert.match(html, /<script src="app\.js"><\/script>/);
  assert.doesNotMatch(html, /<script(?:>|[^>]*\bsrc="https?:)/);
  assert.match(app, /window\.__kocReload\(\)/);
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval|https:\/\/(?!ipc\.localhost)/);
});
