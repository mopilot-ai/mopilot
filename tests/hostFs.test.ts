// Directory browsing on the Host (host/src/hostFs.mjs, package 2.7): bounded to roots, links that leave them refused, delimiters in names kept.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { HostRefusal, createHostFs, isInside } from '../host/src/hostFs.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-fs-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const root = path.join(base, 'root');
const outside = path.join(base, 'outside');
const sibling = path.join(base, 'root-evil');
for (const d of [root, outside, sibling, path.join(root, 'proj', '.git'), path.join(root, 'a b;"\'`$x'), path.join(root, '.hidden')])
  fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(root, 'file.txt'), '');
fs.symlinkSync(outside, path.join(root, 'escape'));
fs.symlinkSync(path.join(root, 'proj'), path.join(root, 'inner-link'));
fs.symlinkSync(path.join(base, 'gone'), path.join(root, 'dangling'));
fs.symlinkSync(path.join(root, 'file.txt'), path.join(root, 'file-link'));
const hfs = createHostFs({ roots: [root, path.join(base, 'no-such-root')] });
const refusal = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: any) => e instanceof HostRefusal && e.code === code);

test('B1/I1: inside is decided by path segment, not prefix', () => {
  assert.equal(isInside('/a/b', '/a/b'), true);
  assert.equal(isInside('/a/b', '/a/b/c'), true);
  assert.equal(isInside('/a/b', '/a/bc'), false);
  assert.equal(isInside('/a/b', '/a'), false);
  assert.equal(isInside('/a/b', '/x'), false);
});

test('lists folders inside the root, sorted, with git marks; files and hidden folders left out', async () => {
  const r = await hfs.list({ path: root });
  assert.equal(r.path, root);
  assert.deepEqual(r.roots, [root]);
  assert.deepEqual(
    r.entries.map((e: any) => e.name),
    ['a b;"\'`$x', 'inner-link', 'proj'],
  );
  assert.equal(r.entries.find((e: any) => e.name === 'proj').git, true);
  assert.equal(r.entries.find((e: any) => e.name === 'inner-link').path, path.join(root, 'proj'));
  assert.ok((await hfs.list({ path: root, hidden: true })).entries.some((e: any) => e.name === '.hidden'));
});

test('I1: names with delimiters and quotes come back intact', async () => {
  assert.equal((await hfs.list({ path: path.join(root, 'a b;"\'`$x') })).entries.length, 0);
});

test('escape attempts are refused: .., absolute outside, sibling prefix, symlink out', async () => {
  await refusal(hfs.list({ path: path.join(root, '..') }), 'outside_roots');
  await refusal(hfs.list({ path: path.join(root, 'proj', '..', '..', 'outside') }), 'outside_roots');
  await refusal(hfs.list({ path: outside }), 'outside_roots');
  await refusal(hfs.list({ path: sibling }), 'outside_roots');
  await refusal(hfs.list({ path: path.join(root, 'escape') }), 'outside_roots');
  await refusal(hfs.list({ path: '/' }), 'outside_roots');
});

test('invalid, missing and non-folder paths get their own refusals', async () => {
  await refusal(hfs.list({ path: 'relative/dir' }), 'invalid_path');
  await refusal(hfs.list({ path: 7 }), 'invalid_path');
  await refusal(hfs.list({ path: `${root}/a\0b` }), 'invalid_path');
  await refusal(hfs.list({ path: path.join(root, 'nope') }), 'directory_missing');
  await refusal(hfs.list({ path: path.join(root, 'dangling') }), 'directory_missing');
  await refusal(hfs.list({ path: path.join(root, 'file.txt') }), 'not_a_directory');
});

test('B3: the entry that is a link out, a dangling link or a file link is left out, not an error', async () => {
  const names = (await hfs.list({ path: root, hidden: true })).entries.map((e: any) => e.name);
  for (const n of ['escape', 'dangling', 'file-link', 'file.txt']) assert.ok(!names.includes(n), n);
});

test('B1: an unreadable entry is skipped', async () => {
  const flaky = createHostFs({
    roots: [root],
    fsp: {
      ...fs.promises,
      realpath: ((p: string) => fs.promises.realpath(p)) as any,
      stat: (async (p: string) => {
        if (String(p).endsWith('proj')) throw new Error('EACCES');
        return fs.promises.stat(p);
      }) as any,
    },
  });
  assert.ok(!(await flaky.list({ path: root })).entries.some((e: any) => e.name === 'inner-link'));
});

test('existingDirectory has no root bound but still refuses a missing path, a file and a relative path', async () => {
  assert.equal(await hfs.existingDirectory(outside), outside);
  await refusal(hfs.existingDirectory(path.join(base, 'nope')), 'directory_missing');
  await refusal(hfs.existingDirectory(path.join(root, 'file.txt')), 'not_a_directory');
  await refusal(hfs.existingDirectory('rel'), 'invalid_path');
});

test('roots default to the home folder; none existing bounds everything out', async () => {
  const d = createHostFs({ home: root });
  assert.deepEqual(await d.roots(), [root]);
  assert.equal(await d.requireDirectory(path.join(root, 'proj')), path.join(root, 'proj'));
  const none = createHostFs({ roots: [path.join(base, 'x')] });
  await refusal(none.list({ path: root }), 'outside_roots');
});

test('without a path the picker starts at the first root that exists; with none that exists it is told so (B1)', async () => {
  const r = await hfs.list({});
  assert.equal(r.path, root);
  assert.deepEqual(r.roots, [root]);
  const none = createHostFs({ roots: [path.join(base, 'no-such-root')] });
  await refusal(none.list({}), 'invalid_path');
});
