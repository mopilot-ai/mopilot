// The review reader's git edges on a scripted git: where the base comes from, every failure it names, and a folder outside its repository root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig } from './support/remote-kit.ts';

const require = createRequire(import.meta.url);
const { createChanges, MAX_FILES } = require('../electron/remote/review/changes.cjs');
const { runGit } = require('../electron/remote/review/ops.cjs');

type Reply = { ok: boolean; stdout?: string; stderr?: string; code?: number | string };
const added = (name: string) => `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+x\n`;

/** A git that answers by the command's first words; `calls` records every command. */
function script(replies: Record<string, Reply>) {
  const calls: string[] = [];
  const run = async (_cmd: string, args: string[]) => {
    calls.push(args.join(' '));
    const key = Object.keys(replies).find((k) => args.join(' ').startsWith(k));
    const r = key ? replies[key] : { ok: false, stdout: '' };
    return { stdout: '', stderr: '', ...r };
  };
  return { run, calls };
}
const changes = (run: any) => createChanges({ run, fs: { realpathSync: (p: string) => p } });
const ABC = 'a'.repeat(40);
const DEF = 'd'.repeat(40);
const BASE = { 'rev-parse --show-toplevel': { ok: true, stdout: '/repo\n' }, 'symbolic-ref': { ok: false } };
const fails = (message: RegExp) => (e: any) => (assert.equal(e.code, 'failed'), assert.match(e.message, message), true);

test('the base is the upstream default branch when usable, else a conventional origin branch', async () => {
  const a = script({
    ...BASE,
    'symbolic-ref': { ok: true, stdout: 'refs/remotes/origin/trunk\n' },
    'merge-base HEAD refs/remotes/origin/trunk': { ok: true, stdout: `${ABC}\n` },
    [`diff ${ABC}`]: { ok: true, stdout: added('f.txt') },
    'ls-files': { ok: true },
  });
  assert.deepEqual(
    (await changes(a.run).filesOf({ cwd: '/repo', scope: 'branch' })).files.map((f: any) => f.path),
    ['f.txt'],
  );
  assert.ok(a.calls.includes('merge-base HEAD refs/remotes/origin/trunk'));
  const b = script({
    ...BASE,
    'merge-base HEAD refs/remotes/origin/master': { ok: true, stdout: `${DEF}\n` },
    'merge-base HEAD refs/remotes/origin/main': { ok: true, stdout: ' \n' },
    [`diff ${DEF}`]: { ok: true, stdout: '' },
    'ls-files': { ok: true },
  });
  await changes(b.run).filesOf({ cwd: '/repo', scope: 'branch' });
  assert.deepEqual(
    b.calls.filter((c) => c.startsWith('merge-base')),
    ['merge-base HEAD refs/remotes/origin/main', 'merge-base HEAD refs/remotes/origin/master'],
  );
});

test('untracked files join the branch: a nested repository is skipped, a new file differs from /dev/null with exit 1, other failures are named', async () => {
  const text = (nested: boolean, code: number | string, out: string) =>
    script({
      ...BASE,
      'merge-base HEAD refs/remotes/origin/main': { ok: true, stdout: `${ABC}\n` },
      [`diff ${ABC}`]: { ok: true },
      'ls-files': { ok: true, stdout: nested ? 'sub/\0new.txt\0' : 'new.txt\0' },
      'diff --no-index': { ok: false, stdout: out, code },
    });
  const ok = text(true, 1, added('new.txt'));
  assert.deepEqual(
    (await changes(ok.run).filesOf({ cwd: '/repo', scope: 'branch' })).files.map((f: any) => f.path),
    ['new.txt'],
  );
  assert.equal(ok.calls.filter((c) => c.startsWith('diff --no-index')).length, 1, 'the nested repository has no content to show');
  await assert.rejects(changes(text(false, 2, '').run).filesOf({ cwd: '/repo', scope: 'branch' }), fails(/untracked file/));
  await assert.rejects(changes(text(false, 1, '').run).filesOf({ cwd: '/repo', scope: 'branch' }), fails(/untracked file/));
});

test('failures are named: no repository, a branch diff, the untracked list', async () => {
  await assert.rejects(changes(script({}).run).filesOf({ cwd: '/x', scope: 'uncommitted' }), fails(/isn't a Git repository/));
  await assert.rejects(
    changes(script({ 'rev-parse --show-toplevel': { ok: true, stdout: '\n' } }).run).filesOf({ cwd: '/x', scope: 'uncommitted' }),
    fails(/isn't a Git repository/),
  );
  await assert.rejects(
    changes(
      script({ ...BASE, 'merge-base HEAD refs/remotes/origin/main': { ok: true, stdout: `${ABC}\n` }, [`diff ${ABC}`]: { ok: false } }).run,
    ).filesOf({
      cwd: '/repo',
      scope: 'branch',
    }),
    fails(/branch changes/),
  );
  await assert.rejects(
    changes(
      script({
        ...BASE,
        'merge-base HEAD refs/remotes/origin/main': { ok: true, stdout: `${ABC}\n` },
        [`diff ${ABC}`]: { ok: true },
        'ls-files': { ok: false },
      }).run,
    ).filesOf({ cwd: '/repo', scope: 'branch' }),
    fails(/untracked files/),
  );
});

test('a folder outside its repository root names paths from the root, and a turn scope with no reader is gone', async () => {
  const s = script({
    ...BASE,
    'rev-parse --show-toplevel': { ok: true, stdout: '/repo\n' },
    'diff HEAD': { ok: true, stdout: added('a.txt') },
    'ls-files': { ok: true },
  });
  const c = createChanges({ run: s.run, fs: { realpathSync: (p: string) => p } });
  assert.deepEqual(
    (await c.filesOf({ cwd: '/elsewhere', scope: 'uncommitted' })).files.map((f: any) => f.path),
    ['a.txt'],
  );
  await assert.rejects(c.filesOf({ cwd: '/repo', scope: 'turn' }), (e: any) => e.code === 'gone');
});

test('git run for the review: its output and exit code, and a folder that is not there', async () => {
  const good = await runGit('git', ['--version'], { cwd: process.cwd() });
  assert.equal(good.ok, true);
  assert.match(good.stdout, /^git version/);
  const localOnly = await runGit('git', ['-c', 'alias.check-lazy=!echo "$GIT_NO_LAZY_FETCH"', 'check-lazy'], {
    cwd: process.cwd(),
    noLazyFetch: true,
  });
  assert.equal(localOnly.stdout.trim(), '1');
  const transport = await runGit('git', ['ls-remote', 'file:///no-remote-needed'], { cwd: process.cwd(), noLazyFetch: true });
  assert.match(transport.stderr, /transport 'file' not allowed/);
  const bad = await runGit('git', ['--version'], { cwd: '/definitely/not/a/folder' });
  assert.deepEqual([bad.ok, bad.code], [false, 'ENOENT']);
  const failed = await runGit('git', ['rev-parse', '--verify', 'nope'], { cwd: process.cwd() });
  assert.deepEqual([failed.ok, failed.code], [false, 128]);
});

test('a listing is capped at its file limit and at its encoded size, and says so', async () => {
  const many = Array.from({ length: MAX_FILES + 5 }, (_v, i) => ({
    path: `f${i}.txt`,
    status: 'added',
    binary: false,
    added: 1,
    removed: 0,
    rows: [],
  }));
  const review = {
    folderOf: async () => '/repo',
    files: async () => ({ files: many, omitted: 0 }),
    turnDiff: async () => undefined,
  };
  const r = rig({ ops: { review } });
  r.known.add('c1');
  const p = r.phone('p1');
  await p.ask('chat.follow', { chatId: 'c1' });
  const list = (await p.ask('diff.list', { chatId: 'c1' })).result;
  assert.deepEqual([list.files.length, list.total, list.truncated], [MAX_FILES, MAX_FILES + 5, true]);
  // long paths: the encoded size, not the count, ends the listing
  const long = many.map((f, i) => ({ ...f, path: `${'d'.repeat(900)}${i}` }));
  const reviewLong = { ...review, files: async () => ({ files: long, omitted: 0 }) };
  const r2 = rig({ ops: { review: reviewLong } });
  r2.known.add('c1');
  const p2 = r2.phone('p1');
  await p2.ask('chat.follow', { chatId: 'c1' });
  const big = (await p2.ask('diff.list', { chatId: 'c1' })).result;
  assert.ok(big.files.length > 50 && big.files.length < 150);
  assert.deepEqual([big.total, big.truncated], [MAX_FILES + 5, true]);
});

test('branch HEAD fallback stays offline while explicit uncommitted keeps its own runner', async () => {
  const s = script({ ...BASE, 'for-each-ref': { ok: true }, remote: { ok: true }, 'diff HEAD': { ok: true }, 'ls-files': { ok: true } });
  const diffs: (boolean | undefined)[] = [];
  const reader = changes(async (cmd: string, args: string[], opts: { noLazyFetch?: boolean }) => {
    if (args[0] === 'diff') diffs.push(opts.noLazyFetch);
    return s.run(cmd, args);
  });
  await reader.filesOf({ cwd: '/repo', scope: 'branch' });
  await reader.filesOf({ cwd: '/repo', scope: 'uncommitted' });
  assert.deepEqual(diffs, [true, undefined]);
});
