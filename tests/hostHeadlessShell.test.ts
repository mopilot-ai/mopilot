// The browser a Host falls back to (host/src/headlessShell.mjs, package 2.6): chrome-headless-shell at a pinned version, unpacked only when the download has the pinned size and sha256.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { PINNED, ShellError, installHeadlessShell, installedShell, platformKey, shellPath } from '../host/src/headlessShell.mjs';
import { zip } from './support/zip-kit.ts';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-shell-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
let n = 0;
const fresh = () => fs.mkdtempSync(path.join(base, `d${++n}-`));

const archive = zip([
  { name: 'chrome-headless-shell-linux64/', mode: 0o040755 },
  { name: 'chrome-headless-shell-linux64/chrome-headless-shell', data: '#!/bin/sh\n', mode: 0o100755 },
]);
const pin = (bytes: Buffer, over: Partial<{ sha256: string; size: number }> = {}) => ({
  version: '1.2.3.4',
  platforms: { linux64: { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, ...over } },
});
/** A fetch that serves `bytes` in two chunks, and what it was asked for. */
function serve(bytes: Buffer, { status = 200, fail = false, breakStream = false } = {}) {
  const asked: string[] = [];
  const impl = (async (url: string) => {
    asked.push(url);
    if (fail) throw new Error('offline');
    const half = Math.floor(bytes.length / 2);
    const body = new ReadableStream({
      start(c) {
        c.enqueue(bytes.subarray(0, half));
        if (breakStream) c.error(new Error('connection reset'));
        else {
          c.enqueue(bytes.subarray(half));
          c.close();
        }
      },
    });
    return { ok: status === 200, status, body: status === 200 ? body : null };
  }) as unknown as typeof fetch;
  return { impl, asked };
}
const code = (c: string) => (e: any) => e instanceof ShellError && e.code === c;

test('the pin names a build, size and sha256 for every platform it supports', () => {
  assert.match(PINNED.version, /^\d+\.\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(PINNED.platforms).sort(), ['linux-arm64', 'linux64', 'mac-arm64', 'mac-x64']);
  for (const p of Object.values(PINNED.platforms) as any[]) {
    assert.match(p.sha256, /^[0-9a-f]{64}$/);
    assert.ok(p.size > 50_000_000);
  }
});

test('platformKey maps this machine to a build, and says none where there is none', () => {
  assert.equal(platformKey('linux', 'x64'), 'linux64');
  assert.equal(platformKey('linux', 'arm64'), 'linux-arm64');
  assert.equal(platformKey('darwin', 'arm64'), 'mac-arm64');
  assert.equal(platformKey('darwin', 'x64'), 'mac-x64');
  for (const [p, a] of [
    ['linux', 'ia32'],
    ['darwin', 'ppc'],
    ['win32', 'x64'],
  ] as const)
    assert.equal(platformKey(p, a), null);
});

test('installedShell finds the pinned build where it is kept, and nothing otherwise', () => {
  const dir = fresh();
  assert.equal(installedShell({ dir, platform: 'linux', arch: 'x64' }), null);
  assert.equal(installedShell({ dir, platform: 'win32', arch: 'x64' }), null);
  const file = shellPath(dir, 'linux64');
  assert.equal(file, path.join(dir, PINNED.version, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  assert.equal(installedShell({ dir, platform: 'linux', arch: 'x64' }), file);
  assert.equal(installedShell({ dir, platform: 'linux', arch: 'x64', exists: () => false }), null);
  assert.equal(installedShell({ dir }), installedShell({ dir, platform: process.platform, arch: process.arch }));
});

test('a download with the pinned size and sha256 is unpacked and the browser can run; a second call downloads nothing', async () => {
  const dir = fresh();
  const s = serve(archive);
  const exe = await installHeadlessShell({ dir, platform: 'linux', arch: 'x64', pin: pin(archive), fetchImpl: s.impl });
  assert.equal(exe, shellPath(dir, 'linux64', pin(archive)));
  assert.equal(fs.statSync(exe).mode & 0o111, 0o111);
  assert.deepEqual(s.asked, ['https://storage.googleapis.com/chrome-for-testing-public/1.2.3.4/linux64/chrome-headless-shell-linux64.zip']);
  assert.equal(await installHeadlessShell({ dir, platform: 'linux', arch: 'x64', pin: pin(archive), fetchImpl: s.impl }), exe);
  assert.equal(s.asked.length, 1);
  // the work folder is gone
  assert.deepEqual(fs.readdirSync(dir), ['1.2.3.4']);
});

test('B1: a download that is not the pinned one is never unpacked, however it fails to match', async () => {
  const dir = fresh();
  const never = (() => assert.fail('unpacked')) as any;
  await assert.rejects(
    installHeadlessShell({
      dir,
      platform: 'linux',
      arch: 'x64',
      pin: pin(archive, { sha256: '0'.repeat(64) }),
      fetchImpl: serve(archive).impl,
      extract: never,
    }),
    code('bad_download'),
  );
  await assert.rejects(
    installHeadlessShell({
      dir,
      platform: 'linux',
      arch: 'x64',
      pin: pin(archive, { size: archive.length + 1 }),
      fetchImpl: serve(archive).impl,
      extract: never,
    }),
    code('bad_download'),
  );
  // more than pinned stops the download itself
  await assert.rejects(
    installHeadlessShell({
      dir,
      platform: 'linux',
      arch: 'x64',
      pin: pin(archive, { size: 10 }),
      fetchImpl: serve(archive).impl,
      extract: never,
    }),
    (e: any) => code('bad_download')(e) && /larger than expected/.test(e.message),
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('B2: an offline Host, a server error and a broken connection each say so and leave nothing behind', async () => {
  const dir = fresh();
  const run = (s: ReturnType<typeof serve>) =>
    installHeadlessShell({ dir, platform: 'linux', arch: 'x64', pin: pin(archive), fetchImpl: s.impl });
  await assert.rejects(run(serve(archive, { fail: true })), (e: any) => code('download_failed')(e) && /offline/.test(e.message));
  await assert.rejects(run(serve(archive, { status: 503 })), (e: any) => code('download_failed')(e) && /503/.test(e.message));
  await assert.rejects(
    run(serve(archive, { breakStream: true })),
    (e: any) => code('download_failed')(e) && /connection reset/.test(e.message),
  );
  assert.deepEqual(fs.readdirSync(dir), []);
  // a retry after a failure works
  await run(serve(archive));
});

test('a machine with no build is told to install Chrome; an install another process finished first is used', async () => {
  const dir = fresh();
  await assert.rejects(
    installHeadlessShell({ dir, platform: 'win32', arch: 'x64', pin: pin(archive), fetchImpl: serve(archive).impl }),
    code('unsupported_platform'),
  );
  const exe = shellPath(dir, 'linux64', pin(archive));
  const racing = (async (...args: any[]) => {
    // the other install lands while this one downloads
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'theirs');
    return (serve(archive).impl as any)(...args);
  }) as unknown as typeof fetch;
  assert.equal(await installHeadlessShell({ dir, platform: 'linux', arch: 'x64', pin: pin(archive), fetchImpl: racing }), exe);
  assert.equal(fs.readFileSync(exe, 'utf8'), 'theirs');
  // a rename that fails for another reason is an error
  const dir2 = fresh();
  await assert.rejects(
    installHeadlessShell({
      dir: dir2,
      platform: 'linux',
      arch: 'x64',
      pin: pin(archive),
      fetchImpl: serve(archive).impl,
      extract: (async () => undefined) as any,
    }),
    (e: any) => e.code === 'ENOENT',
  );
});
