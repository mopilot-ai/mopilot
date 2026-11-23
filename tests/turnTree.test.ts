// A turn's file changes as Git trees (shared/turnTree.mjs), with real git: what a snapshot sees (an edit, a new file, a deletion, a shell's edit, an untracked file, a binary one), and that taking one leaves the repository's index, refs, work tree and stash exactly as they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareTrees, headOf, snapshotTree } from '../shared/turnTree.mjs';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    stdio: 'pipe',
  }).toString();
const git = async (cwd: string, args: string[], env?: Record<string, string | undefined>) =>
  execFileSync('git', args, { cwd, env: { ...process.env, ...env }, stdio: 'pipe', maxBuffer: 1 << 26 }).toString();
const deps = { git, env: () => ({}), fs: fs.promises, tmpdir: os.tmpdir };

function repo(t: any) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'turntree-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  sh(dir, 'init', '-q', '--initial-branch=main');
  for (const f of ['a.txt', 'b.txt', 'gone.txt']) fs.writeFileSync(path.join(dir, f), `${f}\n`);
  fs.writeFileSync(path.join(dir, 'pic.bin'), Buffer.from([0, 1, 2, 3]));
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-qm', 'one');
  return dir;
}
const write = (dir: string, f: string, text: string | Buffer) => fs.writeFileSync(path.join(dir, f), text);
/** The state a snapshot must not change: index, refs, HEAD, stash, status and the files of the work tree. */
const state = (dir: string) => ({
  index: fs.readFileSync(path.join(dir, '.git', 'index')).toString('hex'),
  refs: sh(dir, 'for-each-ref'),
  head: sh(dir, 'rev-parse', 'HEAD'),
  stash: sh(dir, 'stash', 'list'),
  status: sh(dir, 'status', '--porcelain', '-uall'),
  files: fs.readdirSync(dir).sort(),
});

test('a snapshot names an edit, a new file, a deletion, a shell’s edit, an untracked file and a binary one, between two trees', async (t) => {
  const dir = repo(t);
  const before = await snapshotTree(deps, dir);
  write(dir, 'a.txt', 'a edited\n');
  write(dir, 'new.txt', 'new\n');
  fs.rmSync(path.join(dir, 'gone.txt'));
  // what a shell command does: a rename and an append, neither through an editor's tool
  fs.renameSync(path.join(dir, 'b.txt'), path.join(dir, 'moved.txt'));
  fs.appendFileSync(path.join(dir, 'moved.txt'), 'more\n');
  write(dir, 'pic.bin', Buffer.from([9, 8, 7, 0]));
  write(dir, 'blob.bin', Buffer.from([0, 0, 1]));
  const after = await snapshotTree(deps, dir);
  const patch = await compareTrees(git, dir, before, after, undefined);
  for (const name of ['a.txt', 'new.txt', 'gone.txt', 'pic.bin', 'blob.bin'])
    assert.match(patch, new RegExp(`^diff --git a/${name.replace('.', '\\.')} b/`, 'm'), name);
  // the shell's rename and append read as one renamed, edited file
  assert.match(patch, /^rename from b\.txt\nrename to moved\.txt$/m);
  assert.match(patch, /^\+more$/m);
  assert.match(patch, /^\+a edited$/m);
  assert.match(patch, /^deleted file mode/m);
  assert.match(patch, /^GIT binary patch$/m);
  // unchanged files are not in it
  assert.equal(await compareTrees(git, dir, before, before, undefined), '');
});

test('taking a snapshot leaves the index, refs, HEAD, stash, status and the work tree as they were, and no temporary folder behind', async (t) => {
  const dir = repo(t);
  write(dir, 'a.txt', 'staged\n');
  sh(dir, 'add', 'a.txt');
  write(dir, 'a.txt', 'staged and edited\n');
  write(dir, 'untracked.txt', 'u\n');
  const was = state(dir);
  const temp = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('mopilot-turn-')).length;
  const tree = await snapshotTree(deps, dir);
  assert.match(tree, /^[0-9a-f]{40,64}$/);
  assert.deepEqual(state(dir), was);
  assert.equal(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('mopilot-turn-')).length, temp);
  // the tree holds the files as they are on disk, the staged edit's later change and the untracked file included
  assert.equal(sh(dir, 'show', `${tree}:a.txt`), 'staged and edited\n');
  assert.equal(sh(dir, 'show', `${tree}:untracked.txt`), 'u\n');
});

test('a repository with no commit is snapshotted too, and headOf says where HEAD is, or that there is none', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'turntree-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  sh(dir, 'init', '-q', '--initial-branch=main');
  assert.equal(await headOf(git, dir), null);
  write(dir, 'x.txt', 'x\n');
  const tree = await snapshotTree(deps, dir);
  assert.equal(sh(dir, 'show', `${tree}:x.txt`), 'x\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-qm', 'first');
  assert.deepEqual(await headOf(git, dir), { id: sh(dir, 'rev-parse', 'HEAD').trim(), log: 1 });
});

test('a snapshot with no limit takes every untracked file; with one, it leaves out the big ones and still names the odd ones', async (t) => {
  const dir = repo(t);
  write(dir, 'big.txt', 'x'.repeat(300));
  write(dir, 'small 1.txt', 'small\n');
  write(dir, 'star*.txt', 'star\n');
  write(dir, '--option.txt', 'dash\n');
  const all = await snapshotTree(deps, dir);
  assert.equal(sh(dir, 'show', `${all}:big.txt`), 'x'.repeat(300));
  const limited = await snapshotTree({ ...deps, skipUntracked: { file: 100, total: 10_000 } }, dir);
  const names = sh(dir, 'ls-tree', '-r', '--name-only', limited).split('\n');
  assert.equal(names.includes('big.txt'), false);
  for (const kept of ['small 1.txt', 'star*.txt', '--option.txt', 'a.txt']) assert.equal(names.includes(kept), true, kept);
  // a file that vanished while the folder was listed is no failure
  write(dir, 'gone.txt', 'g\n');
  const racing = { ...deps, fs: { ...fs.promises, lstat: async () => Promise.reject(new Error('gone')) } as typeof fs.promises };
  assert.match(await snapshotTree({ ...racing, skipUntracked: { file: 1, total: 1 } }, dir), /^[0-9a-f]{40,64}$/);
  // the diff of a long list of files stops reading batches once past its bound
  for (let i = 0; i < 450; i++) write(dir, `many${i}.txt`, `${i}\n`.repeat(30));
  const before = await snapshotTree(deps, dir);
  for (let i = 0; i < 450; i++) write(dir, `many${i}.txt`, `changed ${i}\n`.repeat(30));
  const after = await snapshotTree(deps, dir);
  const heads = { before: { id: sh(dir, 'rev-parse', 'HEAD').trim(), log: 1 }, after: { id: sh(dir, 'rev-parse', 'HEAD').trim() } };
  const whole = await compareTrees(git, dir, before, after, undefined);
  const bounded = await compareTrees(git, dir, before, after, heads, 100);
  assert.ok(whole.length > 100);
  assert.ok(bounded.length > 0);
});
