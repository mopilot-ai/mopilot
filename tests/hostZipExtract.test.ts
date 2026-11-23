// The Host's zip extractor (host/src/zipExtract.mjs, package 2.6): files stay inside the destination, modes survive, and a damaged, hostile or oversized archive is refused.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { extractZip, ZipError } from '../host/src/zipExtract.mjs';
import { zip } from './support/zip-kit.ts';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-extract-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
let n = 0;
async function unpack(bytes: Buffer, opts?: Parameters<typeof zip>[1]) {
  const dir = path.join(base, `case-${++n}`);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'a.zip');
  fs.writeFileSync(file, bytes);
  const out = path.join(dir, 'out');
  return { out, run: () => extractZip(file, out) };
}
const refused = (message?: RegExp) => (e: any) =>
  e instanceof ZipError && e.code === 'bad_zip' && (message ? message.test(e.message) : true);

test('files, folders and empty files unpack with their contents; the executable bit survives the umask', async () => {
  const big = 'abcdefgh'.repeat(10_000);
  const { out, run } = await unpack(
    zip([
      { name: 'pkg/', mode: 0o040755 },
      { name: 'pkg/run', data: '#!/bin/sh\n', mode: 0o100755 },
      { name: 'pkg/notes/readme.txt', data: 'hello', method: 0 },
      { name: 'pkg/big.bin', data: big },
      { name: 'pkg/empty', data: '', method: 0 },
      { name: 'pkg/noMode', data: 'x', mode: 0o100000 },
    ]),
  );
  const old = process.umask(0o077);
  try {
    await run();
  } finally {
    process.umask(old);
  }
  assert.equal(fs.readFileSync(path.join(out, 'pkg/notes/readme.txt'), 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(out, 'pkg/big.bin'), 'utf8'), big);
  assert.equal(fs.statSync(path.join(out, 'pkg/empty')).size, 0);
  assert.equal(fs.statSync(path.join(out, 'pkg/run')).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(out, 'pkg/noMode')).mode & 0o777, 0o644);
});

test('an archive made without unix modes unpacks with plain files', async () => {
  const { out, run } = await unpack(zip([{ name: 'a.txt', data: 'x' }], { noUnix: true }));
  await run();
  assert.equal(fs.statSync(path.join(out, 'a.txt')).mode & 0o777, 0o644);
  assert.equal(fs.statSync(out).mode & 0o777, 0o700, 'An extraction root stays private under the default umask.');
});

test('B1: a name that leaves the destination, or is not a plain path, is refused before anything is written', async () => {
  for (const name of ['../evil', 'a/../../evil', '/etc/passwd', 'a\\b', 'a\0b', '']) {
    const { out, run } = await unpack(zip([{ name, data: 'x' }]));
    await assert.rejects(run(), refused(/path it should not/));
    assert.equal(fs.existsSync(path.join(out, 'evil')), false);
  }
});

test('B1: links, special files, unknown compressions and a damaged or zip64 directory are refused', async () => {
  await assert.rejects((await unpack(zip([{ name: 'link', data: '/etc/passwd', mode: 0o120777 }]))).run(), refused(/link or special/));
  await assert.rejects((await unpack(zip([{ name: 'dev', data: '', mode: 0o020644 }]))).run(), refused(/link or special/));
  await assert.rejects((await unpack(zip([{ name: 'a', data: 'x', method: 99 }]))).run(), refused(/compression/));
  await assert.rejects((await unpack(Buffer.from('this is not a zip file at all'))).run(), refused(/not a zip/));
  await assert.rejects((await unpack(zip([{ name: 'a', data: 'x' }], { omitEocd: true }))).run(), refused(/not a zip/));
  await assert.rejects((await unpack(zip([{ name: 'a', data: 'x' }], { badCentral: true }))).run(), refused(/damaged/));
  await assert.rejects((await unpack(zip([{ name: 'a', data: 'x' }], { zip64: true }))).run(), refused(/zip64/));
});

test('B2: a file that is not the size the directory says, or an archive that claims more than allowed, is refused', async () => {
  await assert.rejects((await unpack(zip([{ name: 'a', data: 'x'.repeat(100), claimSize: 10 }]))).run(), refused(/larger than it says/));
  await assert.rejects((await unpack(zip([{ name: 'a', data: 'x'.repeat(10), claimSize: 100 }]))).run(), refused(/shorter than it says/));
  await assert.rejects((await unpack(zip([{ name: 'a', data: 'x', claimSize: 3_000_000_000 }]))).run(), refused(/more than allowed/));
  // a local header that is not one
  const broken = zip([{ name: 'a', data: 'x' }]);
  broken.writeUInt32LE(0, 0);
  await assert.rejects((await unpack(broken)).run(), refused(/damaged/));
});
