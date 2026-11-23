// Exercise desktop, Host, and phone branch comparisons against the same real Git history.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { repositoryDiffFiles } from '../src/lib/repositoryChanges.ts';
import { createHostFs } from '../host/src/hostFs.mjs';
import { createHostRead } from '../host/src/hostRead.mjs';
import { branchComparisonBase } from '../shared/gitComparisonBase.mjs';
import { createChanges } from '../electron/remote/review/changes.cjs';

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'branch-comparison-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const read = (cwd: string, args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], { cwd, encoding: 'utf8' });
    return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr, code: r.status ?? -1 };
  };
  const git = (...args: string[]) => {
    const r = read(dir, args);
    assert.ok(r.ok, r.stderr);
    return r.stdout.trim();
  };
  const commit = (name: string) => {
    writeFileSync(path.join(dir, name), 'content\n');
    git('add', name);
    git('commit', '-qm', name);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-qb', 'main');
  const stale = commit('existing.txt');
  git('switch', '-qc', 'task');
  const baseline = commit('from-upstream.txt');
  commit('task.txt');
  git('switch', '-q', '--orphan', 'snapshot');
  const snapshot = commit('public-snapshot.txt');
  git('update-ref', 'refs/remotes/origin/main', snapshot);
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git('switch', '-q', 'task');
  writeFileSync(path.join(dir, 'task.txt'), 'content\npending\n');

  const desktop = (scope: 'branch' | 'uncommitted') =>
    repositoryDiffFiles(
      {
        run: async (cwd, [flag, ...args]) => {
          assert.equal(flag, '--no-lazy-fetch');
          return read(cwd, args);
        },
        status: async () => ({ files: [] }),
        diff: async () => git('diff', 'HEAD'),
      },
      dir,
      scope,
    );
  return {
    dir,
    git,
    baseline,
    stale,
    desktop,
    host: createHostRead({ hostFs: createHostFs({ roots: [dir] }) }),
    phone: createChanges({ run: async (_cmd, args, { cwd }) => read(cwd, args), fs: { realpathSync } }),
  };
}

test('all branch changes readers use the related remote default after a repository cutover', async (t) => {
  const f = fixture(t);
  f.git('remote', 'add', 'company/internal', '/not-fetched');
  f.git('update-ref', 'refs/remotes/company/internal/trunk', f.baseline);
  f.git('symbolic-ref', 'refs/remotes/company/internal/HEAD', 'refs/remotes/company/internal/trunk');
  f.git('update-ref', 'refs/remotes/company/internal/main', f.stale);
  const [desktop, stats, host, phone] = await Promise.all([
    f.desktop('branch'),
    f.host.status({ path: f.dir }),
    f.host.diff({ path: f.dir, scope: 'branch' }),
    f.phone.filesOf({ cwd: f.dir, scope: 'branch' }),
  ]);
  assert.deepEqual(
    desktop.map((file) => file.path),
    ['task.txt'],
  );
  assert.deepEqual(
    stats.files?.map((file) => file.path),
    ['task.txt'],
  );
  assert.match(host.patch!, /diff --git a\/task\.txt b\/task\.txt/);
  assert.doesNotMatch(host.patch!, /from-upstream/);
  assert.deepEqual(
    phone.files.map((file: { path: string }) => file.path),
    ['task.txt'],
  );
});

test('an unrelated remote leaves branch comparison unavailable and pending edits readable', async (t) => {
  const f = fixture(t);
  f.git('update-ref', 'refs/remotes/mirror/main', 'snapshot');
  await assert.rejects(f.desktop('branch'), /comparison base/);
  assert.deepEqual(
    (await f.desktop('uncommitted')).map((file) => file.path),
    ['task.txt'],
  );
  assert.equal((await f.host.status({ path: f.dir })).unreadable, true);
  assert.equal((await f.host.diff({ path: f.dir, scope: 'branch' })).unreadable, true);
  await assert.rejects(f.phone.filesOf({ cwd: f.dir, scope: 'branch' }), /comparison base/);
});

test('a conventional alternate default is usable but divergent alternate merge bases are ambiguous', async (t) => {
  const f = fixture(t);
  f.git('update-ref', 'refs/remotes/internal/main', f.baseline);
  assert.deepEqual(
    (await f.desktop('branch')).map((file) => file.path),
    ['task.txt'],
  );
  f.git('update-ref', 'refs/remotes/mirror/master', f.baseline);
  assert.deepEqual(
    (await f.desktop('branch')).map((file) => file.path),
    ['task.txt'],
  );
  f.git('update-ref', 'refs/remotes/internal/master', f.stale);
  await assert.rejects(f.desktop('branch'), /comparison base/);
  f.git('update-ref', 'refs/remotes/origin/main', f.baseline);
  assert.deepEqual(
    (await f.desktop('branch')).map((file) => file.path),
    ['task.txt'],
  );
});

test('an unborn checkout can still show its files with a fetched remote default', async (t) => {
  const f = fixture(t);
  f.git('checkout', '--', 'task.txt');
  f.git('switch', '-q', '--orphan', 'first');
  writeFileSync(path.join(f.dir, 'first.txt'), 'first\n');
  f.git('add', 'first.txt');
  assert.deepEqual(
    (await f.desktop('branch')).map((file) => file.path),
    ['first.txt'],
  );
  assert.deepEqual(
    (await f.phone.filesOf({ cwd: f.dir, scope: 'branch' })).files.map((file: { path: string }) => file.path),
    ['first.txt'],
  );
});

test('unreadable or incomplete remote discovery does not guess a local base', async () => {
  for (const listing of [
    { ok: false, stdout: '' },
    { ok: true, stdout: 'refs/remotes/company/internal/main\n', cut: true },
    { ok: true, stdout: Array.from({ length: 65 }, (_, index) => `refs/remotes/remote${index}/main`).join('\n') },
  ]) {
    const calls: string[][] = [];
    const base = await branchComparisonBase(async (args) => {
      calls.push(args);
      if (args[0] === 'for-each-ref') return listing;
      if (args[0] === 'remote') return { ok: true, stdout: '' };
      if (args[0] === 'symbolic-ref') return { ok: true, stdout: 'refs/heads/main' };
      return { ok: true, stdout: 'a'.repeat(64), cut: true };
    });
    assert.equal(base, null);
    assert.ok(calls.every((args) => !args.includes('refs/heads/main')));
  }
});

test('unreadable alternate history leaves the comparison unavailable even after another candidate resolves', async () => {
  const result = await branchComparisonBase(async ([command, _head, ref]) => {
    if (command === 'for-each-ref') return { ok: true, stdout: 'refs/remotes/a/main\nrefs/remotes/b/main\n' };
    if (command === 'remote') return { ok: true, stdout: '' };
    if (ref === 'refs/remotes/a/main') return { ok: true, stdout: 'a'.repeat(40) };
    return { ok: false, stdout: '', code: ref === 'refs/remotes/b/main' ? 'ETIMEDOUT' : 128 };
  });
  assert.equal(result, null);
});

test('origin main remains a candidate after an unusable origin HEAD', async (t) => {
  const f = fixture(t);
  f.git('update-ref', 'refs/remotes/origin/trunk', 'snapshot');
  f.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  f.git('update-ref', 'refs/remotes/origin/main', f.baseline);
  assert.deepEqual(
    (await f.desktop('branch')).map((file) => file.path),
    ['task.txt'],
  );
});

test('fetched refs without a known default do not resurrect the stale local base', async (t) => {
  const f = fixture(t);
  f.git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  f.git('update-ref', '-d', 'refs/remotes/origin/main');
  f.git('update-ref', 'refs/remotes/origin/topic', 'snapshot');
  await assert.rejects(f.desktop('branch'), /comparison base/);
});

test('a nested branch called main is not an alternate default without a matching configured remote', async (t) => {
  const f = fixture(t);
  f.git('update-ref', 'refs/remotes/origin/topic/main', f.baseline);
  await assert.rejects(f.desktop('branch'), /comparison base/);
  for (let index = 0; index < 65; index++) f.git('update-ref', `refs/remotes/origin/topic-${index}/main`, f.stale);
  f.git('update-ref', 'refs/remotes/internal/main', f.baseline);
  assert.deepEqual(
    (await f.desktop('branch')).map((file) => file.path),
    ['task.txt'],
  );
});

test('cannot infer an alternate default when the remote inventory is unreadable', async () => {
  const base = await branchComparisonBase(async ([command]) =>
    command === 'for-each-ref'
      ? { ok: true, stdout: 'refs/remotes/company/main\n' }
      : { ok: command === 'remote', stdout: '', cut: command === 'remote' },
  );
  assert.equal(base, null);
});
