// ═══════════════════════════════════════════════════════════════════
// Tauri için web dosyalarını hazırla → tauri/dist-web/
// Ana klasördeki index.html'e DOKUNULMAZ; kopyası üzerinde:
//   • CDN adresleri (xlsx, pdf.js) yerel vendor/ kopyalarıyla değiştirilir
//     → uygulama internetsiz de tam çalışır.
//   • location.reload() → window.__kocReload() (önce veriler diske insin)
// ═══════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = resolve(here, '..');
const root = resolve(tauriDir, '..');           // C:\KocMarket
const out = join(tauriDir, 'dist-web');
const require = createRequire(join(tauriDir, 'package.json'));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'vendor'), { recursive: true });

// 1) Uygulama dosyaları (ana klasörden, değiştirmeden)
for (const f of ['barcode-core.js', 'cari-core.js', 'RELEASE_NOTES.md']) {
  if (existsSync(join(root, f))) copyFileSync(join(root, f), join(out, f));
}

// 2) Kütüphaneler (npm paketlerinden — sürümler CDN ile birebir aynı)
const vendor = {
  'xlsx.full.min.js': require.resolve('xlsx/dist/xlsx.full.min.js'),
  'pdf.min.js': require.resolve('pdfjs-dist/build/pdf.min.js'),
  'pdf.worker.min.js': require.resolve('pdfjs-dist/build/pdf.worker.min.js'),
};
for (const [name, src] of Object.entries(vendor)) copyFileSync(src, join(out, 'vendor', name));

// 3) index.html kopyası + yerel adresler
let html = readFileSync(join(root, 'index.html'), 'utf8');
const swaps = [
  ['https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', 'vendor/xlsx.full.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', 'vendor/pdf.worker.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', 'vendor/pdf.min.js'],
  ['location.reload()', 'window.__kocReload()'],
];
for (const [a, b] of swaps) html = html.split(a).join(b);
const leftover = html.match(/https:\/\/cdnjs\.cloudflare\.com[^"' )]+/g);
if (leftover) console.warn('[hazirla] UYARI: hâlâ CDN adresi var:', [...new Set(leftover)]);
writeFileSync(join(out, 'index.html'), html, 'utf8');

console.log('[hazirla] dist-web hazır:', out);
