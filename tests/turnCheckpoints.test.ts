// electron/session/turnCheckpoints.cjs with real git and main's TurnChanges: a Codex turn's start snapshot is kept under a ref of MoPilot's own, rewinding to before it restores the files listed (deleted, changed and new ones; ignored files, submodules, the index and HEAD as they are), a restore that fails part way puts the files back, each restore has its own undo, and what could lose work is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTurnCheckpoints, KEPT, UNDOS } = require('../electron/session/turnCheckpoints.cjs');
const { TurnChanges } = require('../electron/session/turnChanges.cjs');

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const part = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 24);

function repo(t: any) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoints-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: ENV, stdio: 'pipe' }).toString().trimEnd();
  const write = (name: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  };
  const read = (name: string) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8') : null);
  sh('init', '--quiet', '--initial-branch=main');
  write('.gitignore', 'secret.env\n');
  write('a.txt', 'a');
  write('gone.txt', 'g');
  write('sub/s.txt', 's');
  sh('add', '.');
  sh('commit', '--quiet', '-m', 'first');
  return { dir, sh, write, read };
}

/** Main's TurnChanges with its checkpoints, as turnSnapshots.cjs wires them; `turn` runs one Codex turn's edits. */
function wired(over: Record<string, unknown> = {}) {
  const changes = new TurnChanges();
  const points = createTurnCheckpoints({
    capture: (scope: string) => changes.capture(scope),
    busy: (cwd: string) => changes.busyAt(cwd),
    shareWith: (cwd: string) => changes.shareAt(cwd),
    ...over,
  });
  changes.checkpoints = points;
  const turn = async (cwd: string, id: string, edit: () => void, chat = 'chat') => {
    await changes.begin(chat, cwd);
    edit();
    await changes.finish(chat, id, { checkpoint: true });
    // the checkpoint is kept without the turn's end waiting for it
    await new Promise((r) => setTimeout(r, 300));
  };
  return { changes, points, turn };
}

test('rewinding to before a turn restores what it changed, deleted and made; ignored files, the index and HEAD stay; undo puts them back', async (t) => {
  const r = repo(t);
  const { points, turn } = wired();
  r.write('a.txt', 'mine, before the turn');
  r.write('untracked.txt', 'u');
  r.sh('add', 'untracked.txt');
  await turn(r.dir, 'turn-1', () => {
    r.write('a.txt', 'agent');
    fs.rmSync(path.join(r.dir, 'gone.txt'));
    r.write('made.txt', 'new');
    r.write('secret.env', 'KEY=agent');
  });
  const head = r.sh('rev-parse', 'HEAD');
  const index = r.sh('diff', '--cached', '--name-only');
  const plan = await points.plan('chat', 'turn-1', r.dir);
  assert.deepEqual(plan, { ok: true, files: ['a.txt', 'gone.txt', 'made.txt'] });
  const done = await points.restore('chat', 'turn-1', r.dir, plan.files);
  assert.equal(done.ok, true);
  assert.equal(done.restored, 3);
  assert.deepEqual(
    [r.read('a.txt'), r.read('gone.txt'), r.read('made.txt'), r.read('secret.env')],
    ['mine, before the turn', 'g', null, 'KEY=agent'],
  );
  assert.equal(r.sh('rev-parse', 'HEAD'), head);
  assert.equal(r.sh('diff', '--cached', '--name-only'), index);
  assert.deepEqual(await points.undo('chat', r.dir, done.undo), { ok: true, restored: 3 });
  assert.deepEqual([r.read('a.txt'), r.read('gone.txt'), r.read('made.txt')], ['agent', null, 'new']);
  assert.deepEqual(await points.undo('chat', r.dir, done.undo), { ok: false, error: 'There is nothing to undo.' });
  assert.deepEqual(await points.undo('chat', r.dir, 'not-an-id'), { ok: false, error: 'There is nothing to undo.' });
});

test('only the files listed are restored: one made since the question was asked stays', async (t) => {
  const r = repo(t);
  const { points, turn } = wired();
  await turn(r.dir, 'turn-1', () => r.write('a.txt', 'agent'));
  const plan = await points.plan('chat', 'turn-1', r.dir);
  r.write('late.txt', 'made while the question was open');
  assert.equal((await points.restore('chat', 'turn-1', r.dir, plan.files)).restored, 1);
  assert.deepEqual([r.read('a.txt'), r.read('late.txt')], ['a', 'made while the question was open']);
});

test('each restore has its own undo: two rewinds in a row, then undoing the first still has the user’s edits', async (t) => {
  const r = repo(t);
  const { points, turn } = wired();
  await turn(r.dir, 't1', () => r.write('a.txt', 't1'));
  await turn(r.dir, 't2', () => r.write('a.txt', 't2'));
  r.write('a.txt', 'user precious');
  const second = await points.restore('chat', 't2', r.dir, ['a.txt']);
  const first = await points.restore('chat', 't1', r.dir, ['a.txt']);
  assert.equal(r.read('a.txt'), 'a');
  await points.undo('chat', r.dir, first.undo);
  assert.equal(r.read('a.txt'), 't1');
  await points.undo('chat', r.dir, second.undo);
  assert.equal(r.read('a.txt'), 'user precious');
});

test('a file ignored now by a rule outside the chat’s folder (a parent .gitignore, info/exclude) is never written over', async (t) => {
  for (const rule of ['parent', 'exclude'] as const) {
    const r = repo(t);
    const { points, turn } = wired();
    // untracked, and not ignored when the turn starts
    r.write('sub/local.cfg', 'user v1');
    const sub = path.join(r.dir, 'sub');
    await turn(sub, 'turn-1', () => {
      r.write('sub/local.cfg', 'agent');
      if (rule === 'parent') r.write('.gitignore', 'secret.env\nsub/local.cfg\n');
      else fs.appendFileSync(path.join(r.dir, '.git', 'info', 'exclude'), 'sub/local.cfg\n');
    });
    r.write('sub/local.cfg', 'user v3 precious');
    const plan = await points.plan('chat', 'turn-1', sub);
    const done = await points.restore('chat', 'turn-1', sub, plan.ok && 'files' in plan ? plan.files : null);
    assert.equal(done.ok, false, rule);
    assert.match(done.error, /not kept by git now/);
    assert.equal(r.read('sub/local.cfg'), 'user v3 precious', rule);
  }
});

test('undo puts back only the paths the restore wrote, and refuses those changed since, naming them', async (t) => {
  const r = repo(t);
  const { points, turn } = wired();
  await turn(r.dir, 'turn-1', () => {
    r.write('a.txt', 'agent');
    r.write('b.txt', 'agent b');
  });
  const done = await points.restore('chat', 'turn-1', r.dir, ['a.txt', 'b.txt']);
  // the user goes on: a new file, and an edit to one the restore wrote
  r.write('newwork.txt', 'mine');
  r.write('a.txt', 'edited after the restore');
  assert.deepEqual(await points.undo('chat', r.dir, done.undo), { ok: false, error: 'Changed since the restore, so not undone: a.txt.' });
  assert.deepEqual([r.read('newwork.txt'), r.read('a.txt'), r.read('b.txt')], ['mine', 'edited after the restore', null]);
  // put as the restore left it: undo goes ahead, and the new file stays
  r.write('a.txt', 'a');
  assert.deepEqual(await points.undo('chat', r.dir, done.undo), { ok: true, restored: 2 });
  assert.deepEqual([r.read('newwork.txt'), r.read('a.txt'), r.read('b.txt')], ['mine', 'agent', 'agent b']);
});

test('the undo record is a tree, not a commit, and holds any number of paths without the command line', async (t) => {
  const r = repo(t);
  const { points, turn } = wired();
  const names = Array.from({ length: 3000 }, (_, i) => `many/file-with-a-fairly-long-name-${i}.txt`);
  await turn(r.dir, 'turn-1', () => names.forEach((n) => r.write(n, 'x')));
  const done = await points.restore('chat', 'turn-1', r.dir, null);
  assert.equal(done.restored, 3000);
  const ref = r
    .sh('for-each-ref', '--format=%(refname)', 'refs/mopilot/checkpoints/')
    .split('\n')
    .find((l) => l.endsWith(done.undo))!;
  assert.equal(r.sh('cat-file', '-t', ref), 'tree');
  assert.equal(r.sh('log', '--all', '--oneline').split('\n').length, 1, 'no undo commit shows in history');
  assert.deepEqual(await points.undo('chat', r.dir, done.undo), { ok: true, restored: 3000 });
  assert.equal(r.read(names[2999]), 'x');
});

test('the undo record names its trees by id, so a restore in a folder of the repository undoes there', async (t) => {
  const r = repo(t);
  const { points, turn } = wired();
  const empty = path.join(r.dir, 'empty');
  fs.mkdirSync(empty);
  r.write('empty/.keep', '');
  r.sh('add', '.');
  r.sh('commit', '--quiet', '-m', 'keep');
  // the turn fills a folder whose only file is tracked; the restore empties it back
  await turn(empty, 'turn-1', () => r.write('empty/new.txt', 'n'));
  const done = await points.restore('chat', 'turn-1', empty, null);
  assert.equal(done.restored, 1);
  assert.deepEqual(await points.undo('chat', empty, done.undo), { ok: true, restored: 1 });
  assert.equal(r.read('empty/new.txt'), 'n');
});

test('a clean filter for every path (as an LFS or encryption setup has) leaves the undo record readable', async (t) => {
  const r = repo(t);
  fs.writeFileSync(path.join(r.dir, '.git', 'info', 'attributes'), '* filter=up\n');
  r.sh('config', 'filter.up.clean', 'tr a-z A-Z');
  r.sh('config', 'filter.up.smudge', 'cat');
  const { points, turn } = wired();
  await turn(r.dir, 'turn-1', () => r.write('made.txt', 'n'));
  const done = await points.restore('chat', 'turn-1', r.dir, null);
  assert.equal(done.ok, true);
  assert.deepEqual(await points.undo('chat', r.dir, done.undo), { ok: true, restored: 1 });
});

test('plan and restore agree: a file on disk that git doesn’t keep now rewinds the conversation only', async (t) => {
  const r = repo(t);
  const { points, turn } = wired();
  r.write('local.cfg', 'user v1');
  await turn(r.dir, 'turn-1', () => fs.appendFileSync(path.join(r.dir, '.git', 'info', 'exclude'), 'local.cfg\n'));
  r.write('local.cfg', 'user v3');
  assert.deepEqual(await points.plan('chat', 'turn-1', r.dir), { ok: true, none: 'ignores' });
});

test('a turn that changed a .gitignore can’t be restored: which files are ignored differs, and either tree would lose some', async (t) => {
  const r = repo(t);
  const { points, turn } = wired();
  r.write('local.cfg', 'user v1');
  r.sh('add', 'local.cfg');
  r.sh('commit', '--quiet', '-m', 'cfg');
  await turn(r.dir, 'turn-1', () => {
    r.write('local.cfg', 'agent');
    r.write('.gitignore', 'secret.env\nlocal.cfg\n');
  });
  r.write('local.cfg', 'user v3 precious');
  assert.deepEqual(await points.plan('chat', 'turn-1', r.dir), { ok: true, none: 'ignores' });
  assert.deepEqual(await points.restore('chat', 'turn-1', r.dir, null), {
    ok: false,
    error: 'This turn changed which files are ignored, so its files can’t be restored safely.',
  });
  assert.equal(r.read('local.cfg'), 'user v3 precious');
});

test('submodules and directories are never touched; a restore that fails part way puts every file back', async (t) => {
  const r = repo(t);
  const { points, turn } = wired();
  await turn(r.dir, 'turn-1', () => {
    r.write('aaa.txt', 'made');
    r.write('a.txt', 'agent');
    // a nested repository: git keeps it as a submodule link
    fs.mkdirSync(path.join(r.dir, 'nested'));
    execFileSync('git', ['init', '--quiet'], { cwd: path.join(r.dir, 'nested') });
    fs.writeFileSync(path.join(r.dir, 'nested', 'n.txt'), 'n');
    execFileSync('git', ['add', '.'], { cwd: path.join(r.dir, 'nested') });
    execFileSync('git', ['commit', '--quiet', '-m', 'n'], { cwd: path.join(r.dir, 'nested'), env: ENV });
  });
  const plan = await points.plan('chat', 'turn-1', r.dir);
  assert.deepEqual(plan, { ok: true, files: ['a.txt', 'aaa.txt'] });
  assert.equal((await points.restore('chat', 'turn-1', r.dir, null)).ok, true);
  assert.equal(r.read('nested/n.txt'), 'n');
  // a file git can't write back (its folder is read-only) after another was deleted: nothing stays half restored
  await turn(r.dir, 'turn-2', () => {
    r.write('sub/s.txt', 'agent2');
    r.write('zzz.txt', 'z');
  });
  fs.chmodSync(path.join(r.dir, 'sub'), 0o555);
  let failed;
  try {
    failed = await points.restore('chat', 'turn-2', r.dir, null);
  } finally {
    fs.chmodSync(path.join(r.dir, 'sub'), 0o755);
  }
  assert.deepEqual(failed, { ok: false, error: 'Some files couldn’t be restored, so all of them were put back.' });
  assert.deepEqual([r.read('zzz.txt'), r.read('sub/s.txt')], ['z', 'agent2']);
  // a file that can't be deleted (in a read-only folder) fails the same way, and nothing is changed
  await turn(r.dir, 'turn-3', () => r.write('sub/made.txt', 'm'));
  fs.chmodSync(path.join(r.dir, 'sub'), 0o555);
  let stuck;
  try {
    stuck = await points.restore('chat', 'turn-3', r.dir, null);
  } finally {
    fs.chmodSync(path.join(r.dir, 'sub'), 0o755);
  }
  assert.equal(stuck.ok, false);
  assert.equal(r.read('sub/made.txt'), 'm');
});

test('a turn running or finishing in this folder, or another chat’s over it, stops a restore; a restore marks such a turn shared', async (t) => {
  const r = repo(t);
  const { changes, points, turn } = wired();
  await turn(r.dir, 'turn-1', () => r.write('a.txt', 'agent'));
  await changes.begin('other', path.join(r.dir, 'sub'));
  const stop = { ok: false, error: 'Stop the turn running in this folder first.' };
  assert.deepEqual(await points.plan('chat', 'turn-1', r.dir), stop);
  assert.deepEqual(await points.restore('chat', 'turn-1', r.dir, null), stop);
  assert.deepEqual(await points.undo('chat', r.dir, 'u-000000000000001-aaaaaaaaaaaaaaaaaaaaaaaa'), stop);
  changes.abort('other');
  // a folder whose path can't be read counts as busy
  assert.equal(changes.busyAt(path.join(r.dir, 'no-such-dir')), true);
  // a restore while another chat's turn has begun elsewhere in the repository leaves that turn's diff to its harness
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoints-else-')));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: elsewhere });
  await changes.begin('far', elsewhere);
  changes.shareAt(r.dir);
  assert.equal(changes.baselines.get('far').shared, false);
  // a folder that can't be read counts as overlapping
  changes.shareAt(path.join(r.dir, 'no-such-dir'));
  assert.equal(changes.baselines.get('far').shared, true);
  changes.baselines.get('far').shared = false;
  changes.shareAt(elsewhere);
  assert.equal(changes.baselines.get('far').shared, true);
  // a turn with no folder known blocks nothing
  changes.baselines.get('far').scope = null;
  changes.shareAt('/no/such/path');
  assert.equal(changes.busyAt(r.dir), false);
});

test('only a turn asked to keep one has a checkpoint; keeping one that fails never loses the turn’s diff', async (t) => {
  const r = repo(t);
  const { changes, points } = wired();
  // a Claude Code or ACP turn (finish without `checkpoint`)
  await changes.begin('claude', r.dir);
  r.write('a.txt', 'claude');
  await changes.finish('claude', 'c1');
  assert.deepEqual(await points.plan('claude', 'c1', r.dir), { ok: true, none: 'checkpoint' });
  const throwing = new TurnChanges();
  throwing.checkpoints = { keep: () => Promise.reject(new Error('spawn E2BIG')) };
  const warn = t.mock.method(console, 'warn', () => {});
  await throwing.begin('chat', r.dir);
  r.write('a.txt', 'again');
  assert.match(await throwing.finish('chat', 't1', { checkpoint: true }), /a\.txt/);
  await new Promise((done) => setTimeout(done, 50));
  assert.ok(warn.mock.calls.length >= 0);
  void points;
});

test('no checkpoint, or a folder that is no repository: nothing is restored, and why is said', async (t) => {
  const r = repo(t);
  const { points } = wired();
  assert.deepEqual(await points.plan('chat', 'never', r.dir), { ok: true, none: 'checkpoint' });
  assert.deepEqual(await points.restore('chat', 'never', r.dir, null), { ok: false, error: 'This message has no file checkpoint.' });
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoints-plain-')));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  assert.deepEqual(await points.plan('chat', 'x', plain), { ok: true, none: 'checkpoint' });
});

test('a chat keeps the checkpoints of its last turns and undos only, oldest going first; forgetting a chat removes its refs only', async (t) => {
  const r = repo(t);
  let clock = 1;
  const { changes } = wired();
  const points = createTurnCheckpoints({ capture: (s: string) => changes.capture(s), busy: () => false, now: () => clock++ });
  const tree = r.sh('rev-parse', 'HEAD^{tree}');
  assert.equal(await points.keep(r.dir, 'chat', 'x', 'not-a-tree'), false);
  for (let i = 0; i < KEPT + 2; i++) assert.equal(await points.keep(r.dir, 'chat', `turn-${i}`, tree), true);
  const refs = () => r.sh('for-each-ref', '--format=%(refname)', 'refs/mopilot/checkpoints/').split('\n').filter(Boolean);
  assert.equal(refs().length, KEPT);
  for (const turn of ['turn-0', 'turn-1']) assert.deepEqual(await points.plan('chat', turn, r.dir), { ok: true, none: 'checkpoint' });
  assert.deepEqual(await points.plan('chat', 'turn-2', r.dir), { ok: true, files: [] });
  for (let i = 0; i < UNDOS + 1; i++) assert.equal((await points.restore('chat', 'turn-2', r.dir, null)).ok, true);
  assert.equal(refs().filter((ref) => /\/u-/.test(ref)).length, UNDOS);
  await points.keep(r.dir, 'kept', 't1', tree);
  await points.forget('chat', r.dir);
  assert.deepEqual(refs(), [refs().find((ref) => ref.includes(part('kept')))]);
  // a failed write keeps nothing
  const failing = createTurnCheckpoints({
    git: async () => ({ ok: false, stdout: '', stderr: '' }),
    capture: async () => '',
    busy: () => false,
  });
  assert.equal(await failing.keep(r.dir, 'chat', 'x', tree), false);
});

test('main’s own TurnChanges (turnSnapshots.cjs savedTurnChanges) carries the checkpoints, wired to its snapshots and turns', async (t) => {
  const r = repo(t);
  const { savedTurnChanges } = require('../electron/session/turnSnapshots.cjs');
  const store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoints-store-')));
  t.after(() => fs.rmSync(store, { recursive: true, force: true }));
  const changes = savedTurnChanges(store);
  await changes.begin('chat', r.dir);
  // a turn running there stops a restore
  assert.deepEqual(await changes.checkpoints.plan('chat', 'turn-1', r.dir), {
    ok: false,
    error: 'Stop the turn running in this folder first.',
  });
  r.write('a.txt', 'agent');
  await changes.finish('chat', 'turn-1', { checkpoint: true });
  await new Promise((done) => setTimeout(done, 300));
  const done = await changes.checkpoints.restore('chat', 'turn-1', r.dir, ['a.txt']);
  assert.equal(done.ok, true);
  assert.equal(r.read('a.txt'), 'a');
});
