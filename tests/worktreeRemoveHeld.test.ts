// A worktree folder Windows still holds when it is removed (a cleanup script's terminal that just exited): git deletes what
// it can, drops the admin entry anyway and fails, so the removal finishes the delete once the hold lets go. A read-only
// subfolder stands in for the hold here: git's delete fails on it as it does on a held folder, and the fake fs.rm below
// lifts it, as the holder letting go during fs.rm's retries would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const wt = require('../electron/platform/git.cjs');
const { discardWorktree } = require('../electron/platform/discardWorktree.cjs');
const { removeCheckout } = require('../electron/platform/worktreeRemoval.cjs');

const HELD = { recursive: true, force: true, maxRetries: 17, retryDelay: 100 };

function tempRepo(t: { after: (fn: () => void) => void }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-wt-held-')));
  const holds: string[] = [];
  t.after(() => {
    for (const p of holds) if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const repo = path.join(dir, 'demo');
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  run('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(repo, 'sub', 'b.txt'), 'b\n');
  run('add', '.');
  run('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
  /** Makes `checkout`'s tracked subfolder undeletable until the returned fake fs.rm lifts it. */
  const hold = (checkout: string) => {
    const sub = path.join(checkout, 'sub');
    holds.push(sub);
    fs.chmodSync(sub, 0o555);
    return sub;
  };
  const admins = () => fs.readdirSync(path.join(repo, '.git', 'worktrees'), { withFileTypes: true }).length;
  return { dir, repo, root: path.join(dir, 'worktrees'), run, hold, admins };
}

/** fs/promises whose rm records its options and first runs `before` (the hold letting go, or not). */
function recordingIo(before: () => void) {
  const calls: any[] = [];
  const io = {
    ...fsp,
    rm: async (p: string, o: any) => {
      calls.push([p, o]);
      before();
      return fsp.rm(p, o);
    },
  };
  return { io, calls };
}

test('removeWorktree finishes deleting a held checkout git dropped from its worktrees, and its holder', async (t) => {
  const { repo, root, hold } = tempRepo(t);
  const made = await wt.worktreeAdd(repo, { root });
  const sub = hold(made.worktree);
  const { io, calls } = recordingIo(() => fs.chmodSync(sub, 0o755));
  assert.equal(await wt.removeWorktree({ path: made.worktree, repo }, { io }), true);
  assert.deepEqual(calls, [[made.worktree, HELD]], 'the rest is deleted, retrying the hold');
  assert.equal(fs.existsSync(path.dirname(made.worktree)), false, 'the holder folder goes with it');
  const listed = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  assert.equal(listed.split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
});

test('removeWorktree reports a checkout still held after the retries as kept, without throwing', async (t) => {
  const { repo, root, hold } = tempRepo(t);
  const made = await wt.worktreeAdd(repo, { root });
  hold(made.worktree);
  const busy = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  const io = { ...fsp, rm: async () => Promise.reject(busy) };
  assert.equal(await wt.removeWorktree({ path: made.worktree, repo }, { io }), false);
  assert.equal(fs.existsSync(made.worktree), true);
});

test('removeWorktree leaves a worktree git refused to remove (locked) untouched', async (t) => {
  const { repo, root, run, admins } = tempRepo(t);
  const made = await wt.worktreeAdd(repo, { root });
  run('worktree', 'lock', made.worktree);
  const { io, calls } = recordingIo(() => undefined);
  assert.equal(await wt.removeWorktree({ path: made.worktree, repo }, { io }), false);
  assert.deepEqual(calls, [], 'nothing is deleted');
  assert.equal(fs.existsSync(path.join(made.worktree, 'a.txt')), true);
  assert.equal(admins(), 1, 'git still lists it');
});

test('discardWorktree finishes a clean prepared checkout git could not delete because it is held', async (t) => {
  const { repo, dir, run, hold } = tempRepo(t);
  const worktree = path.join(dir, 'holder', 'demo');
  run('worktree', 'add', '-q', '-b', 'prepared', worktree);
  fs.writeFileSync(path.join(dir, 'holder', '.mopilot-worktree.json'), '{}');
  const sub = hold(worktree);
  const { io, calls } = recordingIo(() => fs.chmodSync(sub, 0o755));
  assert.deepEqual(await discardWorktree({ worktree, repo }, { io }), { discarded: true });
  assert.deepEqual(calls, [[worktree, HELD]]);
  assert.equal(fs.existsSync(path.join(dir, 'holder')), false);
});

test('discardWorktree keeps a prepared checkout with local changes: git refuses before deleting anything', async (t) => {
  const { repo, dir, run, admins } = tempRepo(t);
  const worktree = path.join(dir, 'holder', 'demo');
  run('worktree', 'add', '-q', '-b', 'prepared', worktree);
  fs.writeFileSync(path.join(worktree, 'notes.txt'), 'mine\n');
  const { io, calls } = recordingIo(() => undefined);
  assert.equal((await discardWorktree({ worktree, repo }, { io })).discarded, false);
  assert.deepEqual(calls, []);
  assert.equal(fs.readFileSync(path.join(worktree, 'notes.txt'), 'utf8'), 'mine\n');
  assert.equal(admins(), 1);
});

test('removeCheckout never deletes a folder that was no linked worktree before git ran', async (t) => {
  const { dir, repo } = tempRepo(t);
  const failed = { ok: false, stderr: 'fatal' };
  const { io, calls } = recordingIo(() => undefined);
  // the repository's own checkout (.git is a folder), a .git file naming no admin folder, one naming a missing one
  // (a worktree whose repository moved: `git worktree repair` brings it back, local changes and all)
  const odd = path.join(dir, 'odd');
  const moved = path.join(dir, 'moved');
  fs.mkdirSync(odd);
  fs.mkdirSync(moved);
  fs.writeFileSync(path.join(odd, '.git'), 'not a gitdir line\n');
  fs.writeFileSync(path.join(moved, '.git'), `gitdir: ${path.join(dir, 'gone', '.git', 'worktrees', 'x')}\n`);
  for (const folder of [repo, odd, moved, path.join(dir, 'missing')])
    assert.equal(await removeCheckout(folder, async () => failed, io), failed);
  const done = { ok: true };
  assert.equal(await removeCheckout(repo, async () => done, io), done, "git's success is its own outcome");
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(path.join(repo, 'a.txt')), true);
});

test('removeCheckout keeps a copied checkout git refused, even when the admin entry it names goes meanwhile', async (t) => {
  const { dir, repo, root } = tempRepo(t);
  const made = await wt.worktreeAdd(repo, { root });
  const copy = path.join(dir, 'copy');
  fs.cpSync(made.worktree, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'notes.txt'), 'mine\n');
  const admin = fs
    .readFileSync(path.join(copy, '.git'), 'utf8')
    .replace(/^gitdir:\s*/, '')
    .trim();
  assert.equal(fs.existsSync(admin), true, "the copy names the original worktree's admin entry");
  const { io, calls } = recordingIo(() => undefined);
  // the original's admin entry goes while git refuses the copy ("is not a working tree"): a prune, the original's removal
  const refused = async () => (fs.rmSync(admin, { recursive: true }), { ok: false });
  assert.deepEqual(await removeCheckout(copy, refused, io), { ok: false });
  assert.deepEqual(calls, []);
  assert.equal(fs.readFileSync(path.join(copy, 'notes.txt'), 'utf8'), 'mine\n');
});

test('removeCheckout finishes the folder a symlinked worktree path names, which is the one git deletes', async (t) => {
  const { dir, repo, root, hold, run } = tempRepo(t);
  const made = await wt.worktreeAdd(repo, { root });
  const link = path.join(dir, 'link');
  fs.symlinkSync(made.worktree, link);
  const sub = hold(made.worktree);
  const { io, calls } = recordingIo(() => fs.chmodSync(sub, 0o755));
  const remove = async () => {
    try {
      run('worktree', 'remove', '--force', link);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  };
  assert.deepEqual(await removeCheckout(link, remove, io), { ok: true });
  assert.deepEqual(calls, [[made.worktree, HELD]]);
  assert.equal(fs.existsSync(made.worktree), false);
});

test('removeCheckout keeps the folder when it cannot tell whether git dropped the admin entry', async (t) => {
  const { repo, root } = tempRepo(t);
  const made = await wt.worktreeAdd(repo, { root });
  const failed = { ok: false };
  let ran = false;
  const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
  const io = {
    ...fsp,
    stat: async (p: string, o?: any) => (ran ? Promise.reject(denied) : fsp.stat(p, o)),
    rm: async () => assert.fail('nothing is deleted'),
  };
  assert.equal(await removeCheckout(made.worktree, async () => ((ran = true), failed), io), failed);
  assert.equal(fs.existsSync(made.worktree), true);
});
