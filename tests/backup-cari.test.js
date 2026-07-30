const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('tam dosya yedeği cari kartlarını, açık borçları ve hareketleri içerir', () => {
  assert.match(html, /schemaVersion:\s*3/);
  assert.match(html, /cariState:\s*cariState/);
  assert.match(html, /customerCount:/);
  assert.match(html, /cariEntryCount:/);
});

test('uygulama içi geri alma yedeği cari durumunu da geri yükler', () => {
  assert.match(html, /cariState:\s*JSON\.parse\(JSON\.stringify\(cariState\)\)/);
  assert.match(html, /if \(hasCari\)\s+saveCariState/);
});

test('eski yedekler cari verisi içermiyorsa mevcut cari durumu sessizce silinmez', () => {
  assert.match(html, /const hasCari\s*=/);
  assert.doesNotMatch(html, /else\s+saveCariState\([^)]*createState/);
});

test('tam yedek dosyası geri yüklenirken cari verisi doğrulanarak kaydedilir', () => {
  assert.match(html, /const dc = parsed\.cariState && Array\.isArray\(parsed\.cariState\.customers\)/);
  assert.match(html, /if \(dc\) saveCariState/);
});
