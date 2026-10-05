import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const tauriDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = mkdtempSync(join(tmpdir(), 'koc-bootstrap-test-'));
try {
  const exe = join(testDir, process.platform === 'win32' ? 'bootstrap-tests.exe' : 'bootstrap-tests');
  const compile = spawnSync('rustc', [
    '--edition=2021', '--test', join(tauriDir, 'src-tauri/src/bootstrap.rs'), '-o', exe
  ], { stdio: 'inherit' });
  if (compile.error) throw compile.error;
  if (compile.status !== 0) process.exitCode = compile.status || 1;
  else {
    const result = spawnSync(exe, [], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} finally {
  rmSync(testDir, { recursive: true, force: true });
}
