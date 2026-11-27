// ═══════════════════════════════════════════════════════════════════
// Tauri için web dosyalarını hazırla → tauri/dist-web/
// Ana klasördeki index.html'e DOKUNULMAZ; kopyası üzerinde:
//   • PDF.js CDN adresleri yerel vendor/ kopyalarıyla değiştirilir
//     → uygulama internetsiz de tam çalışır.
//   • location.reload() → window.__kocReload() (önce veriler diske insin)
// ═══════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = resolve(here, '..');
const root = resolve(tauriDir, '..');           // C:\KocMarket
const out = join(tauriDir, 'dist-web');
const require = createRequire(join(tauriDir, 'package.json'));

if (relative(tauriDir, out) !== 'dist-web') throw new Error('Web çıktı dizini doğrulanamadı.');
rmSync(out, { recursive: true, force: true });
const pdfTarget = join(out, 'vendor', 'pdfjs-dist');
mkdirSync(join(pdfTarget, 'legacy', 'build'), { recursive: true });

// 1) Uygulama dosyaları (ana klasörden, değiştirmeden)
for (const f of ['barcode-core.js', 'cari-core.js', 'RELEASE_NOTES.md']) {
  if (existsSync(join(root, f))) copyFileSync(join(root, f), join(out, f));
}

// 2) PDF.js ve PDF metni için gerekli veriler çevrimdışı yerel kaynaklardır.
const pdfSource = dirname(require.resolve('pdfjs-dist/package.json'));
for (const file of ['legacy/build/pdf.mjs', 'legacy/build/pdf.worker.min.mjs', 'LICENSE']) {
  copyFileSync(join(pdfSource, file), join(pdfTarget, file));
}
for (const dir of ['cmaps', 'standard_fonts']) cpSync(join(pdfSource, dir), join(pdfTarget, dir), { recursive:true });
const loader = readFileSync(join(root, 'pdf-loader.mjs'), 'utf8').replace('./node_modules/pdfjs-dist/', './vendor/pdfjs-dist/');
writeFileSync(join(out, 'pdf-loader.mjs'), loader, 'utf8');

// 3) Derlemede uygulama betiğini aynı kaynaktan yerel dosyaya ayır.
// Bu sayede CSP inline script bloklarına izin vermek zorunda kalmaz.
let html = readFileSync(join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (scripts.length !== 1 || /<script[^>]*\bsrc=["'](?:https?:)?\/\//i.test(html)) {
  throw new Error('Çevrimdışı web paketi beklenmeyen script içeriyor.');
}
const [script, appJs] = scripts[0];
html = html.replace(script, '<script src="app.js"></script>');
writeFileSync(join(out, 'app.js'), appJs.replaceAll('location.reload()', 'window.__kocReload()'), 'utf8');
writeFileSync(join(out, 'index.html'), html, 'utf8');

console.log('[hazirla] dist-web hazır:', out);
