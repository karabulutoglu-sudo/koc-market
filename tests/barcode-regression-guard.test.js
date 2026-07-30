const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('premium arayüz değişse de ana barkod giriş sözleşmesi korunur', () => {
  assert.match(html, /id="barcodeInput"[^>]*onkeydown="handleBarcodeKey\(event\)"/);
  assert.match(html, /function handleBarcodeKey\(e\)/);
  assert.match(html, /function doScan\(\)/);
  assert.match(html, /function addToCart\(barcode,\s*qty\)/);
});

test('Enter ve Tab barkod sonlandırıcıları doScan çağrısını korur', () => {
  assert.match(
    html,
    /function handleBarcodeKey\(e\)\{[\s\S]*?isTerminator\(e\.key\)[\s\S]*?e\.preventDefault\(\);[\s\S]*?doScan\(\);/
  );
});

test('odak başka yerdeyken sonlandırıcı kaybolmaz ve barkodlar birleşmez', () => {
  assert.match(
    html,
    /document\.addEventListener\('keydown'[\s\S]*?if \(isTerminator\)[\s\S]*?inp\.value\.trim\(\)[\s\S]*?doScan\(\);/
  );
});

test('aynı barkod yeniden okutulunca yeni satır yerine mevcut satırın adedi artar', () => {
  assert.match(html, /const ci = cart\.find\(x => x\.b === barcode\)/);
  assert.match(html, /if \(ci\) \{[\s\S]*?ci\.q \+= qty;/);
});

test('barkod normalleştirme ve satış odağı korumaları yerinde kalır', () => {
  assert.match(html, /function _normBarcode\(x\)/);
  assert.match(html, /function _barcodeFocusTarget\(\)/);
  assert.match(html, /function focusBarcode\(\)/);
  assert.match(html, /attachBarcodeBlurGuard/);
});
