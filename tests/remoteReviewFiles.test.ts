// file.read's reader: only a text file inside the project folder, never hidden, never through a link out, size-bounded, and the file opened is the one checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useFakeFs } from './support/ports/fs.ts';

const require = createRequire(import.meta.url);
const { readFileInside, wholeChars } = require('../electron/remote/review/safeFile.cjs');

function folder(t: { after: (fn: () => void) => void }) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-files-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(base, 'outside'));
  return { base, root };
}
const read = (root: string, rel: string, extra: Record<string, number> = {}) =>
  readFileInside({ folder: root, path: rel, offset: 0, maxBytes: 65536, ...extra });
const refused = (code: string, message?: RegExp) => (e: any) => (
  assert.equal(e.code, code, e.message), message && assert.match(e.message, message), true
);

test('reads a text file by its folder-relative path', async (t) => {
  const { root } = folder(t);
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'héllo\nworld\n');
  const r = await read(root, 'src/a.ts');
  assert.deepEqual(r, { path: 'src/a.ts', text: 'héllo\nworld\n', size: 13, offset: 0, bytes: 13, truncated: false });
  assert.equal((await read(root, './src/../src/a.ts')).path, 'src/a.ts');
});

test('a read is bounded and ends on a whole character; the next read starts where it ended', async (t) => {
  const { root } = folder(t);
  fs.writeFileSync(path.join(root, 'u.txt'), 'aé€😀z');
  const first = await read(root, 'u.txt', { maxBytes: 4 });
  assert.deepEqual([first.text, first.bytes, first.truncated], ['aé', 3, true]);
  const second = await read(root, 'u.txt', { offset: first.bytes, maxBytes: 100 });
  assert.deepEqual([second.text, second.truncated], ['€😀z', false]);
  const past = await read(root, 'u.txt', { offset: 1000 });
  assert.deepEqual([past.text, past.bytes, past.truncated], ['', 0, false]);
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(500_000));
  const big = await read(root, 'big.txt', { maxBytes: 96 * 1024 });
  assert.deepEqual([big.bytes, big.size, big.truncated], [96 * 1024, 500_000, true]);
});

test('wholeChars keeps a complete character and drops a cut one', () => {
  assert.equal(wholeChars(Buffer.from('ab')).length, 2);
  assert.equal(wholeChars(Buffer.from('a€')).length, 4);
  assert.equal(wholeChars(Buffer.from('a€').subarray(0, 3)).length, 1);
  assert.equal(wholeChars(Buffer.from('😀').subarray(0, 3)).length, 0);
  assert.equal(wholeChars(Buffer.from([0xc3])).length, 0);
});

test('a binary file is not read, whether the NUL is at the start or in the part asked for', async (t) => {
  const { root } = folder(t);
  fs.writeFileSync(path.join(root, 'a.bin'), Buffer.from([1, 2, 0, 3]));
  await assert.rejects(read(root, 'a.bin'), refused('invalid', /text file/));
  fs.writeFileSync(path.join(root, 'late.txt'), `${'x'.repeat(20_000)}\0tail`);
  await assert.rejects(read(root, 'late.txt', { offset: 19_000, maxBytes: 5000 }), refused('invalid', /text file/));
  assert.equal((await read(root, 'late.txt', { maxBytes: 100 })).bytes, 100);
});

test('paths that climb out, hidden names, the folder itself and absolute paths are refused alike', async (t) => {
  const { base, root } = folder(t);
  fs.writeFileSync(path.join(base, 'secret.txt'), 'secret');
  fs.writeFileSync(path.join(root, '.env'), 'KEY=1');
  fs.writeFileSync(path.join(root, '.git', 'config'), 'x');
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, '.hidden', 'a.txt'), 'x');
  for (const rel of [
    '../secret.txt',
    'src/../../secret.txt',
    '.env',
    '.git/config',
    '.hidden/a.txt',
    'src/../.env',
    '.',
    '',
    path.join(base, 'secret.txt'),
    '/etc/passwd',
  ])
    await assert.rejects(read(root, rel), refused('invalid', /isn't in the project folder/), rel);
});

test('a link out of the folder, or to a hidden file, is refused; a link inside reads the file it names', async (t) => {
  const { base, root } = folder(t);
  fs.writeFileSync(path.join(base, 'outside', 'secret.txt'), 'secret');
  fs.writeFileSync(path.join(root, '.env'), 'KEY=1');
  fs.writeFileSync(path.join(root, 'real.txt'), 'real');
  fs.symlinkSync(path.join(base, 'outside', 'secret.txt'), path.join(root, 'abs-link.txt'));
  fs.symlinkSync('../outside', path.join(root, 'dir-link'));
  fs.symlinkSync('.env', path.join(root, 'env-link'));
  fs.symlinkSync('real.txt', path.join(root, 'ok-link'));
  fs.symlinkSync('src', path.join(root, 'src-link'));
  for (const rel of ['abs-link.txt', 'dir-link/secret.txt', 'env-link'])
    await assert.rejects(read(root, rel), refused('invalid', /isn't in the project folder/), rel);
  assert.equal((await read(root, 'ok-link')).path, 'real.txt');
  // the folder itself may be reached through a link
  const alias = path.join(base, 'alias');
  fs.symlinkSync(root, alias);
  assert.equal((await read(alias, 'real.txt')).text, 'real');
});

test('a missing file, a folder, a folder that is gone and a dangling link say so', async (t) => {
  const { base, root } = folder(t);
  fs.symlinkSync('nowhere', path.join(root, 'dangling'));
  await assert.rejects(read(root, 'nope.txt'), refused('gone', /isn't there/));
  await assert.rejects(read(root, 'dangling'), refused('gone', /isn't there/));
  await assert.rejects(read(root, 'src'), refused('invalid', /folder, not a file/));
  await assert.rejects(read(path.join(base, 'missing'), 'a.txt'), refused('gone', /folder isn't there/));
});

test('a file swapped for another, or for a link, between the check and the read is not read', async (t) => {
  const { base, root } = folder(t);
  const file = path.join(root, 'a.txt');
  fs.writeFileSync(file, 'one');
  fs.writeFileSync(path.join(base, 'outside', 'x.txt'), 'outside');
  // swapped for a different file (another inode) before it is opened
  const real = fs.promises;
  useFakeFs(t, {
    promises: {
      open: async (...args: any[]) => {
        // the new file exists beside the old one before it replaces it, so its inode differs on every file system
        fs.writeFileSync(`${file}.new`, 'two');
        fs.renameSync(`${file}.new`, file);
        return real.open(...(args as [string, number]));
      },
    },
  });
  await assert.rejects(read(root, 'a.txt'), refused('stale', /changed while/));
});

test('a file swapped for a link before it is opened, or whose path leads elsewhere once opened, is not read', async (t) => {
  const { base, root } = folder(t);
  const file = path.join(root, 'a.txt');
  fs.writeFileSync(file, 'one');
  fs.writeFileSync(path.join(base, 'outside', 'x.txt'), 'outside');
  const real = fs.promises;
  let mode = 'link';
  useFakeFs(t, {
    promises: {
      open: async (...args: any[]) => {
        if (mode === 'link') {
          fs.rmSync(file);
          fs.symlinkSync(path.join(base, 'outside', 'x.txt'), file);
        }
        const fh = await real.open(...(args as [string, number]));
        if (mode === 'path') {
          // the path leads elsewhere once the file is open: its inode is the one checked
          const stat = fh.stat.bind(fh);
          fh.stat = async () => {
            const s = await stat();
            fs.renameSync(file, path.join(root, 'moved.txt'));
            fs.symlinkSync('moved.txt', file);
            fs.writeFileSync(path.join(root, 'other.txt'), 'x');
            fs.rmSync(file);
            fs.symlinkSync('other.txt', file);
            return s;
          };
        }
        return fh;
      },
    },
  });
  await assert.rejects(read(root, 'a.txt'), refused('stale', /changed while/));
  fs.rmSync(file);
  fs.writeFileSync(file, 'one');
  mode = 'path';
  await assert.rejects(read(root, 'a.txt'), refused('stale', /changed while/));
});

test('a reply stays within its byte budget when escapes or replacement characters make the text larger than the file', async (t) => {
  const { root } = folder(t);
  // 90 KB of control characters is 540 KB once JSON-escaped; invalid UTF-8 becomes 3-byte replacement characters
  fs.writeFileSync(path.join(root, 'ctl.txt'), '\u0001'.repeat(90_000));
  const first = await read(root, 'ctl.txt', { maxBytes: 96 * 1024 });
  assert.ok(Buffer.byteLength(JSON.stringify(first.text)) <= 100_000);
  assert.ok(first.bytes > 0 && first.bytes < 90_000 && first.truncated);
  const next = await read(root, 'ctl.txt', { offset: first.bytes, maxBytes: 96 * 1024 });
  assert.ok(next.bytes > 0, 'the next read advances');
  fs.writeFileSync(path.join(root, 'bad.txt'), Buffer.alloc(90_000, 0xff));
  const bad = await read(root, 'bad.txt', { maxBytes: 96 * 1024 });
  assert.ok(Buffer.byteLength(JSON.stringify(bad.text)) <= 100_000 && bad.truncated);
});

test('a link that lands in a sibling whose name differs only by case is outside (case-sensitive volumes)', async (t) => {
  const { base } = folder(t);
  const root = path.join(base, 'Proj');
  fs.mkdirSync(root);
  useFakeFs(t, {
    promises: {
      realpath: async (p: string) => (p.endsWith('link.txt') ? path.join(base, 'proj', 'x.txt') : p),
    },
  });
  await assert.rejects(read(root, 'link.txt'), refused('invalid', /isn't in the project folder/));
});
