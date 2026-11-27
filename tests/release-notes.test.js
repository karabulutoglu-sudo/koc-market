const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('güncelleme notu mevcut sürüm numarasını içerir', () => {
  const pkg = JSON.parse(read('package.json'));
  const notes = read('RELEASE_NOTES.md');
  assert.match(notes, new RegExp(`\\b${pkg.version.replace(/\./g, '\\.')}\\b`));
});

test('güncelleme notu boş bir başlıktan ibaret değildir', () => {
  const meaningfulLines = read('RELEASE_NOTES.md')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
  assert.ok(meaningfulLines.length >= 1);
});

test('uygulama güncelleme penceresinde sürüm ve notları gösterir', () => {
  const main = read('main.js');
  assert.match(main, /formatReleaseNotes\(info\)/);
  assert.match(main, /detail:\s*'BU GÜNCELLEMEDE:/);
  assert.match(main, /info && info\.version/);
});

test('yayın iş akışı not yoksa durur ve notları GitHub yayınına ekler', () => {
  const workflow = read('.github/workflows/build.yml');
  assert.match(workflow, /Güncelleme notlarını doğrula/);
  assert.match(workflow, /gh release edit/);
  assert.match(workflow, /--notes-file RELEASE_NOTES\.md/);
});

test('Tauri yayını kök JavaScript ile paketlenmiş PDF ve CSP testlerine bağlıdır', () => {
  const workflow = read('.github/workflows/tauri-build.yml');
  const signing = workflow.indexOf('uses: tauri-apps/tauri-action@');
  assert.ok(signing > 0);
  const checks = workflow.slice(0, signing);
  assert.match(checks, /- name: Kökteki JavaScript testleri\r?\n\s+run: npm test/);
  assert.match(checks, /npm run hazirla[\s\S]*?npm run test:pdf\r?\n\s+if \(\$LASTEXITCODE -ne 0\) \{ throw/);
});

test('Tauri ön sürümü yayın hedefini denetler ve derlenen commit ile etiketlenir', () => {
  const workflow = read('.github/workflows/tauri-build.yml');
  const signing = workflow.indexOf('uses: tauri-apps/tauri-action@');
  assert.ok(signing > 0);
  assert.match(workflow.slice(0, signing), /node tauri\/scripts\/verify-release-target\.mjs \$version \$commit\r?\n\s+if \(\$LASTEXITCODE -ne 0\) \{ throw/);
  assert.match(workflow.slice(signing), /tagName: \$\{\{ steps\.meta\.outputs\.tag \}\}/);
  assert.match(workflow.slice(signing), /releaseCommitish: \$\{\{ steps\.meta\.outputs\.commit \}\}/);
  assert.match(workflow.slice(signing), /^\s+prerelease: true\r?$/m);
});
