const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const barcode = require('../barcode-core.js');

test('barkod baş/son boşluk ve görünmez karakterlerden temizlenir', () => {
  assert.equal(barcode.normalize(' 8690504001065\u200B '), '8690504001065');
});

test('okuyucunun Enter ve Tab sonlandırmaları kabul edilir', () => {
  assert.equal(barcode.isTerminator('Enter'), true);
  assert.equal(barcode.isTerminator('Tab'), true);
  assert.equal(barcode.isTerminator('Escape'), false);
});

test('barkod karakterleri yakalanır, kontrol tuşları barkoda eklenmez', () => {
  for (const key of '8690504001065') assert.equal(barcode.isAppendableKey(key), true);
  assert.equal(barcode.isAppendableKey('Enter'), false);
  assert.equal(barcode.isAppendableKey('Tab'), false);
  assert.equal(barcode.isAppendableKey('F1'), false);
});

test('paketlenmiş uygulama barkod çekirdeğini içerir', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(packageJson.build.files.includes('barcode-core.js'), true);
});

test('satış ekranı barkod çekirdeğini yükler ve boş odaktaki sonlandırmayı işler', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /<script src="barcode-core\.js"><\/script>/);
  assert.match(html, /if \(isTerminator\) \{[\s\S]*?if \(inp\.value\.trim\(\)\) \{[\s\S]*?doScan\(\);/);
});
