const test = require('node:test');
const assert = require('node:assert/strict');

const helper = import('../scripts/verify-release-target.mjs');
const version = '2.1.0';
const repository = 'market/app';
const tag = `tauri-v${version}`;
const ref = `refs/tags/${tag}`;
const checkout = 'a'.repeat(40);
const other = 'b'.repeat(40);
const preview = { tag_name: tag, draft: false, prerelease: true };

async function verify(gitOutput = '', pages = [[]]) {
  const { verifyReleaseTarget } = await helper;
  return verifyReleaseTarget(version, checkout, repository, (program, args) => {
    if (program === 'git') {
      assert.deepEqual(args, ['ls-remote', '--tags', 'origin', ref, `${ref}^{}`]);
      return gitOutput;
    }
    assert.equal(program, 'gh');
    assert.deepEqual(args, ['api', '--method', 'GET', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`]);
    return JSON.stringify(pages);
  });
}

test('yeni ön sürüme ve aynı commit üzerindeki etikete izin verir', async () => {
  assert.equal(await verify(), tag);
  assert.equal(await verify(`${checkout}\t${ref}\n`), tag);
});

test('aynı commit üzerindeki ön sürümü açıklamalı etiketle tekrar derleyebilir', async () => {
  assert.equal(await verify(`${other}\t${ref}\r\n${checkout}\t${ref}^{}\r\n`, [[preview]]), tag);
});

test('başka bir commit üzerindeki etiketi ve etiketsiz ön sürümü reddeder', async () => {
  await assert.rejects(verify(`${other}\t${ref}\n`), /derlenen commit ile uyuşmuyor/);
  await assert.rejects(verify('', [[preview]]), /Git etiketi bulunamadı/);
});

test('kararlı sürümü ve taslağı GitHub listesinin sonraki sayfalarında da reddeder', async () => {
  const gitOutput = `${checkout}\t${ref}\n`;
  await assert.rejects(verify(gitOutput, [[], [{ ...preview, prerelease: false }]]), /kararlı yayın veya taslak/);
  await assert.rejects(verify(gitOutput, [[], [{ ...preview, draft: true }]]), /kararlı yayın veya taslak/);
});

test('geçersiz Git veya GitHub yanıtında ön sürüme devam etmez', async () => {
  await assert.rejects(verify('beklenmedik çıktı'), /uzak Git etiketi doğrulanamadı/);
  await assert.rejects(verify('', {}), /GitHub sürüm listesi doğrulanamadı/);
});
