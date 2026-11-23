// scripts/fetch-vendor.mjs: the pinned ripgrep is only unpacked when its archive matches the checksum.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { RIPGREP, RIPGREP_VERSION, fetchRipgrep, sha256, verifyArchive } = await import('../scripts/fetch-vendor.mjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sage-vendor-'));

test('every supported platform and arch has a pinned archive and a 64-hex checksum', () => {
  assert.equal(RIPGREP_VERSION, '15.2.0');
  assert.deepEqual(Object.keys(RIPGREP).sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']);
  for (const [target, pin] of Object.entries(RIPGREP) as [string, any][]) {
    assert.match(pin.sha256, /^[0-9a-f]{64}$/, target);
    assert.ok(pin.asset.includes(RIPGREP_VERSION), target);
  }
});

test('an archive that is not the pinned one is refused, whatever it is called', () => {
  assert.throws(() => verifyArchive('darwin-arm64', Buffer.from('not ripgrep')), /SHA-256 is .* expected 3750b2e9/);
  assert.throws(() => verifyArchive('freebsd-x64', Buffer.from('x')), /No ripgrep/);
});

test('fetchRipgrep unpacks a verified archive and nothing else, and skips when it is already there', async () => {
  // a stand-in archive whose checksum is pinned for this test only
  const src = tmp();
  const inner = path.join(src, `ripgrep-${RIPGREP_VERSION}-aarch64-apple-darwin`);
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, 'rg'), '#!/bin/sh\necho ripgrep\n');
  fs.writeFileSync(path.join(inner, 'COPYING'), 'c');
  fs.writeFileSync(path.join(inner, 'README.md'), 'not shipped');
  const asset = RIPGREP['darwin-arm64'].asset;
  const archive = path.join(src, asset);
  execFileSync('tar', ['-czf', archive, '-C', src, path.basename(inner)]);
  const real = RIPGREP['darwin-arm64'].sha256;
  RIPGREP['darwin-arm64'].sha256 = sha256(fs.readFileSync(archive));
  try {
    const out = path.join(tmp(), 'ripgrep');
    let downloads = 0;
    const download = async () => (downloads++, fs.readFileSync(archive));
    const bin = await fetchRipgrep({ platform: 'darwin', arch: 'arm64', out, download });
    assert.equal(bin, path.join(out, 'rg'));
    assert.equal(fs.statSync(bin).mode & 0o111, 0o111);
    assert.deepEqual(fs.readdirSync(out).sort(), ['.version', 'COPYING', 'rg']);
    await fetchRipgrep({ platform: 'darwin', arch: 'arm64', out, download });
    assert.equal(downloads, 1);
    // a tampered download is refused and leaves nothing behind
    const bad = path.join(tmp(), 'ripgrep');
    await assert.rejects(
      fetchRipgrep({ platform: 'darwin', arch: 'arm64', out: bad, download: async () => Buffer.from('tampered') }),
      /SHA-256/,
    );
    assert.equal(fs.existsSync(bad), false);
  } finally {
    RIPGREP['darwin-arm64'].sha256 = real;
  }
});

test('fetchRipgrep unpacks the Windows zip with unzip on Linux, where tar has no zip support', async () => {
  const src = tmp();
  const name = `ripgrep-${RIPGREP_VERSION}-x86_64-pc-windows-msvc`;
  fs.mkdirSync(path.join(src, name));
  fs.writeFileSync(path.join(src, name, 'rg.exe'), 'MZ');
  fs.writeFileSync(path.join(src, name, 'LICENSE-MIT'), 'm');
  const asset = RIPGREP['win32-x64'].asset;
  execFileSync('zip', ['-qr', path.join(src, asset), name], { cwd: src });
  const real = RIPGREP['win32-x64'].sha256;
  RIPGREP['win32-x64'].sha256 = sha256(fs.readFileSync(path.join(src, asset)));
  try {
    const out = path.join(tmp(), 'ripgrep');
    const bin = await fetchRipgrep({ platform: 'win32', arch: 'x64', out, from: src, host: 'linux' });
    assert.equal(bin, path.join(out, 'rg.exe'));
    assert.deepEqual(fs.readdirSync(out).sort(), ['.version', 'LICENSE-MIT', 'rg.exe']);
  } finally {
    RIPGREP['win32-x64'].sha256 = real;
  }
});
