// A machine's Changes pane lists the same rows as this Mac's for one repository state, big and binary untracked files included (#5277): this Mac's readers (electron/platform/gitDiff.cjs, gitQueries.cjs) and the real Host's (host/src/hostRead.mjs through electron/host/folders.cjs) read one real git repository.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { realHostFolders } from './support/realHostFolders.ts';
import { diffTotals, parseUnifiedDiff, unshownNote } from '../src/lib/diff.ts';
import { repoOf } from '../src/lib/hostRepo.ts';
// @ts-ignore: plain ESM without declarations
import { MAX_UNTRACKED_BYTES } from '../host/src/hostRead.mjs';

const require = createRequire(import.meta.url);
const { createGitDiff } = require('../electron/platform/gitDiff.cjs');
const { createGitQueries } = require('../electron/platform/gitQueries.cjs');

const world = realHostFolders();
after(() => world.dispose());

/** This Mac's own git runner, as main runs it: `diff --no-index` exits 1 when the files differ. */
const run = async (cmd: string, args: string[], options: { cwd: string }) => {
  const r = spawnSync(cmd, args, { cwd: options.cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
};

/** The repository of the J9 run: tracked changes, a small untracked file, a big one over the Host's count bound, a bigger one, and a binary one. */
const dir = world.repo();
const bigLines = 'a line of a big new file\n'.repeat(Math.ceil((MAX_UNTRACKED_BYTES + 1) / 25));
fs.writeFileSync(path.join(dir, 'big.txt'), bigLines);
fs.writeFileSync(path.join(dir, 'huge.txt'), 'x\n'.repeat(500_000));
fs.writeFileSync(path.join(dir, 'blob.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));

test('the fixture holds files over the Host bound and a binary one', () => {
  assert.ok(fs.statSync(path.join(dir, 'big.txt')).size > MAX_UNTRACKED_BYTES);
  assert.ok(fs.statSync(path.join(dir, 'huge.txt')).size >= 1_000_000);
});

test('the machine pane lists every row this Mac lists, and the summary counts the same files', async () => {
  const local = parseUnifiedDiff(await createGitDiff(run)(dir));
  const machine = parseUnifiedDiff((await world.folders.diff('box', { path: dir, scope: 'uncommitted' })).patch);
  const paths = (files: { path: string }[]) => files.map((f) => f.path).sort();
  assert.deepEqual(paths(local), ['big.txt', 'blob.dat', 'huge.txt', 'new.txt', 'pic.bin']);
  assert.deepEqual(paths(machine), paths(local), 'one row per file on both sources');
  assert.equal(machine.find((f) => f.path === 'blob.dat')?.binary, true, 'a binary untracked file is a binary row on both');
  const status = await world.folders.status('box', { path: dir });
  assert.equal(repoOf(status).files, paths(local).length, 'the summary counts the rows the pane lists');
  const localStatus = await createGitQueries({ run }).gitStatus(dir);
  assert.equal(localStatus.files.length, paths(local).length);
});

test('a big untracked file is a row that says it is too large to show, with its size, and no lines', async () => {
  const machine = parseUnifiedDiff((await world.folders.diff('box', { path: dir, scope: 'uncommitted' })).patch);
  for (const name of ['big.txt', 'huge.txt']) {
    const row = machine.find((f) => f.path === name);
    assert.ok(row, `${name} has a row`);
    assert.equal(row.isNew, true);
    assert.equal(row.tooLarge, fs.statSync(path.join(dir, name)).size);
    assert.equal(row.lines.length, 0, 'its content is not read');
    assert.match(unshownNote(row) ?? '', /^File too large to show \(/);
  }
  assert.equal(unshownNote(machine.find((f) => f.path === 'blob.dat')!), 'Binary file');
  assert.equal(unshownNote(machine.find((f) => f.path === 'new.txt')!), null);
  assert.deepEqual(diffTotals(machine.filter((f) => f.path === 'new.txt')), { added: 2, removed: 0 });
});

test('the branch scope lists the same rows as the uncommitted one', async () => {
  const a = parseUnifiedDiff((await world.folders.diff('box', { path: dir, scope: 'uncommitted' })).patch);
  const b = parseUnifiedDiff((await world.folders.diff('box', { path: dir, scope: 'branch' })).patch);
  assert.deepEqual(b.map((f) => f.path).sort(), a.map((f) => f.path).sort());
});

test('the placeholder keeps a quoted path and does not call the patch cut', async () => {
  const odd = path.join(dir, 'odd "name".txt');
  fs.writeFileSync(odd, 'y\n'.repeat(200_000));
  const reply = await world.folders.diff('box', { path: dir, scope: 'uncommitted' });
  assert.equal(reply.truncated, false, 'a placeholder is a row, not a cut');
  assert.equal(parseUnifiedDiff(reply.patch).find((f) => f.path === 'odd "name".txt')?.tooLarge, 400_000);
  fs.rmSync(odd);
});
