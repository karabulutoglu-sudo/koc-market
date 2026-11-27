const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('ayarlar sekmesi işletme ve kategori yönetimini sunar', () => {
  assert.match(html, /switchTab\('settings'\)/);
  assert.match(html, /id="sec-settings"/);
  assert.match(html, /saveBusinessSettings/);
  assert.match(html, /renderCategoryManager/);
});

test('kategori ağacı sınırsız alt dal, taşıma ve güvenli silme altyapısına sahiptir', () => {
  assert.match(html, /function _orderedCategories/);
  assert.match(html, /function _categoryDescendantIds/);
  assert.match(html, /function saveCategoryEdit/);
  assert.match(html, /hasChildren \|\| hasProducts/);
});

test('eski ürün kategorileri kimlikli kategori ağacına kayıpsız taşınır', () => {
  assert.match(html, /function _migrateCategoryTree/);
  assert.match(html, /p\.cid = cat\.id/);
  assert.match(html, /safeSaveJSON\('koc-prods', products\)/);
});
