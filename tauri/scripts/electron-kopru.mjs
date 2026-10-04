// ═══════════════════════════════════════════════════════════════════
// ELECTRON → TAURI GEÇİŞ KÖPRÜSÜ
// Marketteki Electron uygulamasının güncelleyicisi (electron-updater)
// GitHub'daki en son yayında "latest.yml" dosyasını arar. Bu betik,
// Tauri kurulum dosyasını gösteren bir latest.yml üretir. Böylece Electron
// "2.0.0 güncellemesi hazır" der ve Tauri kurulumunu indirip başlatır.
//
// Kullanım: node scripts/electron-kopru.mjs <setup.exe> <sürüm> <çıktı-klasörü>
// Çıktı: koc-market-tauri-setup-<sürüm>.exe (ASCII ad) + latest.yml
// ═══════════════════════════════════════════════════════════════════
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [exe, version, outDir] = process.argv.slice(2);
if (!exe || !version || !outDir) {
  console.error('Kullanım: node scripts/electron-kopru.mjs <setup.exe> <sürüm> <çıktı-klasörü>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const name = `koc-market-tauri-setup-${version}.exe`;   // GitHub'da bozulmayan ASCII ad
copyFileSync(exe, join(outDir, name));
const buf = readFileSync(join(outDir, name));
const sha512 = createHash('sha512').update(buf).digest('base64');
const size = statSync(join(outDir, name)).size;
const yml = [
  `version: ${version}`,
  `files:`,
  `  - url: ${name}`,
  `    sha512: ${sha512}`,
  `    size: ${size}`,
  `path: ${name}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  ''
].join('\n');
writeFileSync(join(outDir, 'latest.yml'), yml, 'utf8');
console.log(yml);
