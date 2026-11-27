import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const versionPattern = /^\d+\.\d+\.\d+(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i;
const commitPattern = /^[0-9a-f]{40}$/i;

export function verifyReleaseTarget(version, checkoutCommit, repository, run = execFileSync) {
  if (!versionPattern.test(version) || !commitPattern.test(checkoutCommit)) {
    throw new Error('Ön sürüm doğrulaması için sürüm numarası ve tam commit SHA gerekli.');
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY, kullanıcı/depo biçiminde olmalı.');
  }

  const tag = `tauri-v${version}`;
  const ref = `refs/tags/${tag}`;
  const peeled = `${ref}^{}`;
  const gitOutput = run('git', ['ls-remote', '--tags', 'origin', ref, peeled], { encoding: 'utf8' });
  const refs = new Map();
  for (const line of gitOutput.trim().split(/\r?\n/).filter(Boolean)) {
    const [hash, name] = line.split('\t');
    if (!commitPattern.test(hash) || (name !== ref && name !== peeled) || refs.has(name)) {
      throw new Error(`${tag} için uzak Git etiketi doğrulanamadı.`);
    }
    refs.set(name, hash.toLowerCase());
  }
  const target = refs.get(peeled) ?? refs.get(ref);
  if (target && (!refs.has(ref) || target !== checkoutCommit.toLowerCase())) {
    throw new Error(`${tag} etiketi derlenen commit ile uyuşmuyor.`);
  }

  const pages = JSON.parse(run('gh', [
    'api', '--method', 'GET', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  if (!Array.isArray(pages) || pages.length === 0 || !pages.every(Array.isArray)) {
    throw new Error('GitHub sürüm listesi doğrulanamadı.');
  }
  for (const release of pages.flat()) {
    if (release.tag_name !== tag) continue;
    if (release.draft !== false || release.prerelease !== true) {
      throw new Error(`${tag} adıyla bir kararlı yayın veya taslak zaten var.`);
    }
    if (!target) {
      throw new Error(`${tag} ön sürümünün Git etiketi bulunamadı.`);
    }
  }
  return tag;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.env.GH_TOKEN?.trim()) {
      throw new Error('GitHub sürüm listesini doğrulamak için GH_TOKEN gerekli.');
    }
    const tag = verifyReleaseTarget(process.argv[2], process.argv[3], process.env.GITHUB_REPOSITORY);
    console.log(`${tag} ön sürüm hedefi doğrulandı.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
