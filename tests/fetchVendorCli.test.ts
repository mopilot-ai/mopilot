// scripts/fetch-vendor.mjs: the download helper, the Windows and offline paths, and the command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, recorder, runScript, tempDir } from './support/scripts-shared-cli.ts';

const { RIPGREP, RIPGREP_VERSION, defaultDownload, fetchRipgrep, main, sha256 } = await import('../scripts/fetch-vendor.mjs');

test('the default download follows redirects and refuses an HTTP error', async () => {
  const ok = recorder(async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('bytes').buffer }));
  assert.equal((await defaultDownload('https://x/a', ok as any)).toString(), 'bytes');
  assert.deepEqual(ok.calls[0], ['https://x/a', { redirect: 'follow' }]);
  await assert.rejects(
    defaultDownload('https://x/b', async () => ({ ok: false, status: 404 }) as any),
    /https:\/\/x\/b: HTTP 404/,
  );
});

test('an unpinned target is refused before anything is read', async () => {
  await assert.rejects(fetchRipgrep({ platform: 'freebsd', arch: 'x64', out: tempDir() }), /No ripgrep 15\.2\.0 is pinned for freebsd-x64/);
});

test('a Windows archive from a local folder unpacks rg.exe without changing its mode', async () => {
  const src = tempDir();
  const asset = RIPGREP['win32-x64'].asset;
  const inner = path.join(src, asset.replace(/\.zip$/, ''));
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, 'rg.exe'), 'MZ');
  fs.writeFileSync(path.join(inner, 'LICENSE-MIT'), 'mit');
  // a real zip: a Mac unpacks it with bsdtar, Linux with unzip (scripts/fetch-vendor.mjs)
  execFileSync('zip', ['-qr', path.join(src, asset), path.basename(inner)], { cwd: src });
  const real = RIPGREP['win32-x64'].sha256;
  RIPGREP['win32-x64'].sha256 = sha256(fs.readFileSync(path.join(src, asset)));
  try {
    const out = path.join(tempDir(), 'ripgrep');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'rg.exe'), 'old');
    fs.writeFileSync(path.join(out, '.version'), 'older');
    const bin = await fetchRipgrep({ platform: 'win32', arch: 'x64', out, from: src, download: () => assert.fail('no download') });
    assert.equal(bin, path.join(out, 'rg.exe'));
    assert.equal(fs.readFileSync(bin, 'utf8'), 'MZ');
    assert.deepEqual(fs.readdirSync(out).sort(), ['.version', 'LICENSE-MIT', 'rg.exe']);
    assert.equal(fs.readFileSync(path.join(out, '.version'), 'utf8'), `${RIPGREP_VERSION} ${RIPGREP['win32-x64'].sha256}\n`);
  } finally {
    RIPGREP['win32-x64'].sha256 = real;
  }
});

test('the command line defaults to this machine and build/vendor, and honours its flags', async () => {
  const fetchRg = recorder(async (o: any) => path.join(o.out, 'rg'));
  const log = recorder();
  const bin = await main([], { fetch: fetchRg, platform: 'darwin', arch: 'arm64', log });
  const out = path.join(REPO, 'build/vendor/darwin-arm64/ripgrep');
  assert.deepEqual(fetchRg.calls[0][0], { platform: 'darwin', arch: 'arm64', out, from: undefined });
  assert.equal(bin, path.join(out, 'rg'));
  assert.deepEqual(log.calls[0], [`ripgrep ${RIPGREP_VERSION} (darwin-arm64) verified: ${bin}`]);
  await main(['--platform', 'win32', '--arch', 'x64', '--out', 'tmp/rg', '--from', '/src'], { fetch: fetchRg, log });
  assert.deepEqual(fetchRg.calls[1][0], { platform: 'win32', arch: 'x64', out: path.resolve('tmp/rg'), from: '/src' });
});

test('run directly, an unpinned platform fails with the reason and no download', () => {
  const r = runScript('scripts/fetch-vendor.mjs', ['--platform', 'freebsd', '--arch', 'x64', '--out', path.join(tempDir(), 'rg')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No ripgrep 15\.2\.0 is pinned for freebsd-x64/);
});
