// The Host's read-only file views (host/src/hostFiles.mjs, #4104): a folder's entries and a file's start, bounded in size and time, only inside the roots by real path, regular files only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createHostFs } from '../host/src/hostFs.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostFiles, DEFAULT_READ_BYTES, MAX_READ_BYTES, MAX_TREE_ENTRIES } from '../host/src/hostFiles.mjs';
// @ts-ignore: plain ESM without declarations
import { callHost, startServer } from '../host/src/server.mjs';
// @ts-ignore: plain ESM without declarations
import { createPaths } from '../host/src/paths.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-files-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const root = path.join(base, 'root');
const outside = path.join(base, 'outside');
fs.mkdirSync(path.join(root, 'proj', 'src'), { recursive: true });
fs.mkdirSync(outside);
const hostFs = createHostFs({ roots: [root] });
const files: any = createHostFiles({ hostFs });
const proj = path.join(root, 'proj');
const put = (rel: string, body: string | Buffer) => fs.writeFileSync(path.join(proj, rel), body);

test('a folder lists its folders first, then its files, by name; links that leave the roots, and special files, are left out', async () => {
  put('b.txt', 'b');
  put('a.txt', 'a');
  put('.hidden', 'h');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
  fs.mkdirSync(path.join(outside, 'dir'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(proj, 'leak-file'));
  fs.symlinkSync(path.join(outside, 'dir'), path.join(proj, 'leak-dir'));
  fs.symlinkSync(path.join(proj, 'a.txt'), path.join(proj, 'inside-link'));
  fs.symlinkSync(path.join(proj, 'src'), path.join(proj, 'inside-dir-link'));
  fs.symlinkSync(path.join(proj, 'missing'), path.join(proj, 'dangling'));
  const mk = spawnSync('mkfifo', [path.join(proj, 'pipe')]);
  assert.equal(mk.status, 0);
  const t = await files.tree({ path: proj });
  assert.equal(t.path, proj);
  assert.equal(t.truncated, false);
  assert.deepEqual(t.entries, [
    { name: 'inside-dir-link', isDirectory: true },
    { name: 'src', isDirectory: true },
    { name: '.hidden', isDirectory: false },
    { name: 'a.txt', isDirectory: false },
    { name: 'b.txt', isDirectory: false },
    { name: 'inside-link', isDirectory: false },
  ]);
});

test('a folder past the bound is cut and says so', async () => {
  const big = path.join(root, 'big');
  fs.mkdirSync(big);
  for (let i = 0; i < MAX_TREE_ENTRIES + 3; i++) fs.writeFileSync(path.join(big, `f${i}`), '');
  const t = await files.tree({ path: big });
  assert.deepEqual([t.entries.length, t.truncated], [MAX_TREE_ENTRIES, true]);
  const named = t.entries.map((e: any) => e.name);
  assert.deepEqual(
    named,
    [...named].sort((a, b) => a.localeCompare(b)),
    'listed by name',
  );
  assert.equal(named.includes('f999') && named.includes('f2002'), false, 'the cut leaves out the last names, always the same ones');
});

test('a file reads as text with its size; a long one is cut at the limit, never inside a character; a binary one gives its size', async () => {
  put('small.txt', 'héllo\n');
  assert.deepEqual(await files.read({ path: path.join(proj, 'small.txt') }), { kind: 'text', text: 'héllo\n', size: 7, truncated: false });
  put('long.txt', `${'x'.repeat(100)}é${'y'.repeat(50)}`);
  const cut = await files.read({ path: path.join(proj, 'long.txt'), limit: 101 });
  assert.equal(cut.truncated, true);
  assert.equal(cut.text, 'x'.repeat(100), 'half of é is dropped');
  const all = await files.read({ path: path.join(proj, 'long.txt'), limit: 5000 });
  assert.equal(all.truncated, false);
  put('empty.txt', '');
  assert.deepEqual(await files.read({ path: path.join(proj, 'empty.txt') }), { kind: 'text', text: '', size: 0, truncated: false });
  put('img.bin', Buffer.from([1, 2, 0, 3]));
  assert.deepEqual(await files.read({ path: path.join(proj, 'img.bin') }), { kind: 'binary', size: 4 });
  put('big.txt', 'z'.repeat(DEFAULT_READ_BYTES + 10));
  assert.equal((await files.read({ path: path.join(proj, 'big.txt') })).text.length, DEFAULT_READ_BYTES, 'the default bound');
  assert.equal(
    (await files.read({ path: path.join(proj, 'big.txt'), limit: MAX_READ_BYTES * 2 })).text.length,
    DEFAULT_READ_BYTES + 10,
    'never past the largest bound',
  );
});

test('a name with a backslash is listed; a file that says it is empty is read to the bound; a swapped-in pipe is judged on the open handle', async () => {
  fs.writeFileSync(path.join(proj, 'we\\ird'), 'w');
  const t = await files.tree({ path: proj });
  assert.equal(
    t.entries.some((e: any) => e.name === 'we\\ird'),
    true,
  );
  // a file whose size is 0 but that has content (procfs, sysfs)
  const content = Buffer.from('from the kernel\n');
  const handle = (size: number) => ({
    stat: async () => ({ size, isFile: () => true }),
    read: async (buf: Buffer) => ({ bytesRead: content.copy(buf) }),
    close: async () => undefined,
  });
  const proc = createHostFiles({ hostFs, fsp: { ...fs.promises, open: async () => handle(0) } as any }) as any;
  assert.deepEqual(await proc.read({ path: path.join(proj, 'a.txt') }), {
    kind: 'text',
    text: 'from the kernel\n',
    size: 16,
    truncated: false,
  });
  const endless = createHostFiles({ hostFs, fsp: { ...fs.promises, open: async () => handle(0) } as any }) as any;
  const cut = await endless.read({ path: path.join(proj, 'a.txt'), limit: 4 });
  assert.deepEqual([cut.text, cut.truncated], ['from', true]);
  const binary = createHostFiles({
    hostFs,
    fsp: {
      ...fs.promises,
      open: async () => ({ ...handle(0), read: async (b: Buffer) => ({ bytesRead: Buffer.from([1, 0]).copy(b) }) }),
    } as any,
  }) as any;
  assert.deepEqual(await binary.read({ path: path.join(proj, 'a.txt') }), { kind: 'binary', size: 2 });
  // the handle is closed also when the file turns out to be no regular file
  let closed = 0;
  const swapped = createHostFiles({
    hostFs,
    fsp: {
      ...fs.promises,
      open: async () => ({ stat: async () => ({ size: 0, isFile: () => false }), close: async () => void closed++ }),
    } as any,
  }) as any;
  await assert.rejects(swapped.read({ path: path.join(proj, 'a.txt') }), (e: any) => e.code === 'not_a_file');
  assert.equal(closed, 1);
});

test('a folder, a pipe, a missing path, a link out of the roots and a path outside them are refused with their reason', async () => {
  const code = (p: string) =>
    files.read({ path: p }).then(
      () => 'read',
      (e: any) => e.code,
    );
  assert.equal(await code(proj), 'not_a_file');
  assert.equal(await code(path.join(proj, 'pipe')), 'not_a_file');
  assert.equal(await code(path.join(proj, 'nope')), 'directory_missing');
  assert.equal(await code(path.join(proj, 'leak-file')), 'outside_roots');
  assert.equal(await code(path.join(outside, 'secret.txt')), 'outside_roots');
  assert.equal(await code('relative.txt'), 'invalid_path');
  const treeCode = (p: string) =>
    files.tree({ path: p }).then(
      () => 'read',
      (e: any) => e.code,
    );
  assert.equal(await treeCode(outside), 'outside_roots');
  assert.equal(await treeCode(path.join(proj, 'leak-dir')), 'outside_roots');
  assert.equal(await treeCode(path.join(proj, 'a.txt')), 'not_a_directory');
});

test('a read that does not finish in time is a coded refusal, and the timer does not outlive it', async () => {
  const slow = createHostFiles({
    hostFs,
    timeoutMs: 20,
    fsp: { ...fs.promises, open: () => new Promise(() => undefined), readdir: () => new Promise(() => undefined) } as any,
  }) as any;
  await assert.rejects(slow.read({ path: path.join(proj, 'a.txt') }), (e: any) => e.code === 'read_timed_out');
  await assert.rejects(slow.tree({ path: proj }), (e: any) => e.code === 'read_timed_out');
});

test('over the socket the methods answer a paired client, refuse bad requests, and are unknown without directory wiring', async () => {
  const paths = createPaths({ dataDir: path.join(base, 'sock'), env: {} });
  const server = await startServer({ paths, dirs: { hostFs, hostGit: {}, hostFiles: files } as any });
  try {
    const t: any = await callHost(paths.socketPath, 'fs.tree', { path: proj });
    assert.equal(
      t.result.entries.some((e: any) => e.name === 'src'),
      true,
    );
    const r: any = await callHost(paths.socketPath, 'fs.read', { path: path.join(proj, 'small.txt'), limit: 3 });
    assert.deepEqual([r.result.kind, r.result.truncated], ['text', true]);
    assert.equal(((await callHost(paths.socketPath, 'fs.read', { path: path.join(outside, 'secret.txt') })) as any).code, 'outside_roots');
    assert.match(((await callHost(paths.socketPath, 'fs.read', { path: path.join(proj, 'a.txt'), limit: 0 })) as any).error, /size/);
    assert.match(
      ((await callHost(paths.socketPath, 'fs.read', { path: path.join(proj, 'a.txt'), limit: 2_000_000 })) as any).error,
      /size/,
    );
    assert.match(((await callHost(paths.socketPath, 'fs.tree', { path: 5 })) as any).error, /folder/);
  } finally {
    await server.close();
  }
  const bare = createPaths({ dataDir: path.join(base, 'sock2'), env: {} });
  const unwired = await startServer({ paths: bare });
  try {
    for (const m of ['fs.tree', 'fs.read'])
      assert.match(((await callHost(bare.socketPath, m, { path: proj })) as any).error, /Unknown method/);
  } finally {
    await unwired.close();
  }
});
