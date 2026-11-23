// The folder guard restores a pruned managed worktree through real Git using authoritative chat repository metadata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deferred, tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { chatFolderGuard } = require('../electron/session/chatFolderGuard.cjs');
const git = require('../electron/platform/git.cjs');

test('sending after cleanup removed the entire holder restores its kept branch from the chat record', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-recovery-')));
  const repo = path.join(dir, 'repo');
  const root = path.join(dir, 'worktrees');
  fs.mkdirSync(repo);
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  try {
    run('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'kept.txt'), 'the branch survives\n');
    run('add', '.');
    run('-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'initial');
    const made = await git.worktreeAdd(repo, { root });
    assert.equal(made.ok, true);
    await git.removeWorktree({ path: made.worktree, repo });
    assert.equal(fs.existsSync(path.dirname(made.worktree)), false);
    const records = new Map<string, any>([
      ['fork', { meta: {} }],
      ['original', { meta: { worktreeOf: repo } }],
    ]);
    const guard = chatFolderGuard({
      chatProject: async () => made.path,
      state: () => ({ prefs: { worktreeRoot: root } }),
      chats: () => store,
    });
    const store = {
      records,
      patchMeta: (id: string, patch: object) => (records.set(id, { meta: patch }), true),
    };
    await guard({ chatId: 'fork' });
    assert.equal(records.get('fork').meta.worktreeOf, repo);
    assert.equal(fs.readFileSync(path.join(made.path, 'kept.txt'), 'utf8'), 'the branch survives\n');
    assert.equal(git.worktreeInfo(made.path).branch, made.branch);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('folder provenance can use hidden saved owners without exposing a chat list', async () => {
  const records = new Map<string, any>([
    ['fork', { meta: {} }],
    ['hidden', { meta: { worktreeOf: '/repo', momo: 'main' } }],
    ['previous', { meta: { worktreeOf: '/repo', momo: 'previous' } }],
  ]);
  const reads: string[] = [];
  const writes: unknown[][] = [];
  const restores: unknown[][] = [];
  const store = {
    records,
    patchMeta: (id: string, patch: object) => (writes.push([id, patch]), records.set(id, { meta: patch }), true),
  };
  const guard = chatFolderGuard({
    chatProject: async (id: string) => (reads.push(id), '/wt/a/repo'),
    state: () => null,
    chats: () => store,
    exists: () => false,
    restore: async (...args: unknown[]) => (restores.push(args), { ok: true, restored: false }),
  });
  await guard({ chatId: 'fork' });
  assert.deepEqual(reads, ['fork', 'hidden', 'previous']);
  assert.deepEqual(writes, [['fork', { worktreeOf: '/repo' }]]);
  assert.equal(restores[0][2], '/repo');
});

test('mixed saved and missing origins serialize by folder, retrying a failed marker-only restore with the saved origin', async () => {
  const started = deferred<void>();
  const first = deferred<any>();
  const records = new Map<string, any>();
  const store = { records };
  const calls: unknown[][] = [];
  const guard = chatFolderGuard({
    chatProject: async () => '/wt/a/repo',
    state: () => null,
    chats: () => store,
    exists: () => false,
    restore: (...args: unknown[]) => {
      calls.push(args);
      started.resolve();
      return calls.length === 1 ? first.promise : { ok: true, restored: false };
    },
  });
  const unknown = assert.rejects(guard({ chatId: 'old-fork' }), /project folder is gone/);
  await started.promise;
  records.set('saved', { meta: { worktreeOf: '/repo' } });
  const known = guard({ chatId: 'saved' });
  await tick();
  assert.equal(calls.length, 1);
  first.resolve({ ok: false, error: 'The project folder is gone' });
  await Promise.all([unknown, known]);
  assert.deepEqual(
    calls.map((args) => args[2]),
    [null, '/repo'],
  );
});

test('marker-only callers share failures, and a caller without metadata can join a successful saved-origin restore', async () => {
  for (const saved of [false, true]) {
    const first = deferred<any>();
    const started = deferred<void>();
    const records = new Map<string, any>(saved ? [['a', { meta: { worktreeOf: '/repo' } }]] : []);
    const store = { records };
    let count = 0;
    let sourceReads = 0;
    const guard = chatFolderGuard({
      chatProject: async (id: string) => (id === 'a' && ++sourceReads > 1 ? null : '/wt/a/repo'),
      state: () => null,
      chats: () => store,
      exists: () => false,
      restore: () => {
        count++;
        started.resolve();
        return first.promise;
      },
    });
    const one = guard({ chatId: 'a' });
    const result = saved ? one : assert.rejects(one, /missing origin/);
    await started.promise;
    const two = guard({ chatId: 'b' });
    const second = saved ? two : assert.rejects(two, /missing origin/);
    await tick();
    if (saved) first.resolve({ ok: true, restored: false });
    else first.reject(new Error('missing origin'));
    await Promise.all([result, second]);
    assert.equal(count, 1);
  }
});

test('legacy recovery refuses conflicting workspace owners and failed provenance persistence', async () => {
  const records = new Map<string, any>([
    ['fork', { meta: {} }],
    ['a', { meta: { worktreeOf: '/repo-a' } }],
    ['b', { meta: { worktreeOf: '/repo-b' } }],
  ]);
  let saved = false;
  const store = { records, patchMeta: () => saved };
  const calls: unknown[][] = [];
  const guard = chatFolderGuard({
    chatProject: async () => '/wt/a/repo',
    state: () => null,
    chats: () => store,
    exists: () => false,
    restore: async (...args: unknown[]) => (calls.push(args), { ok: true, restored: false }),
  });
  await assert.rejects(guard({ chatId: 'fork' }), /Saved chats disagree/);
  assert.equal(calls.length, 0);
  records.delete('b');
  await assert.rejects(guard({ chatId: 'fork' }), /Couldn't save this chat's project folder/);
  assert.equal(calls.length, 0);
  saved = true;
  await guard({ chatId: 'fork' });
  assert.equal(calls[0][2], '/repo-a');
});

test('a saved repository that is actually gone is refused without treating its origin as missing metadata', async () => {
  const store = { records: new Map([['a', { meta: { worktreeOf: '/gone-repository' } }]]) };
  let calls = 0;
  const guard = chatFolderGuard({
    chatProject: async () => '/wt/a/repo',
    state: () => null,
    chats: () => store,
    exists: () => false,
    restore: async () => (calls++, { ok: false, error: 'The project folder is gone' }),
  });
  await assert.rejects(guard({ chatId: 'a' }), /project folder is gone/);
  assert.equal(calls, 1);
});

test('inferred origins only come from the exact folder and current source record; retired target records are never patched', async () => {
  for (const retire of ['source', 'store', 'target', 'different-folder', 'absent-target', 'no-writer']) {
    const read = deferred<string>();
    const records = new Map<string, any>([
      ['fork', { meta: {} }],
      ['source', { meta: { worktreeOf: '/repo' } }],
    ]);
    let patches = 0;
    const original = {
      records,
      patchMeta: retire === 'no-writer' ? undefined : (id: string, patch: object) => (patches++, records.set(id, { meta: patch }), true),
    };
    let store = original;
    const calls: unknown[][] = [];
    if (retire === 'absent-target') records.delete('fork');
    const guard = chatFolderGuard({
      chatProject: (id: string) => (id === 'source' ? read.promise : Promise.resolve('/wt/a/repo')),
      state: () => null,
      chats: () => store,
      exists: () => false,
      restore: async (...args: unknown[]) => (calls.push(args), { ok: true, restored: false }),
    });
    const attempt = guard({ chatId: 'fork' });
    const result = ['store', 'target'].includes(retire)
      ? assert.rejects(attempt, /project changed/)
      : retire === 'no-writer'
        ? assert.rejects(attempt, /Couldn't save/)
        : attempt;
    await tick();
    if (retire === 'source') records.set('source', { meta: { worktreeOf: '/replacement' } });
    if (retire === 'store') store = { ...original, records: new Map() };
    if (retire === 'target') records.set('fork', { meta: { worktreeOf: '/new-target' } });
    read.resolve(retire === 'different-folder' ? '/other' : '/wt/a/repo');
    await result;
    if (['store', 'target', 'no-writer'].includes(retire)) {
      assert.equal(patches, 0, retire);
      assert.equal(calls.length, 0, retire);
    } else {
      assert.equal(patches, retire === 'absent-target' ? 1 : 0, retire);
      assert.equal(calls[0][2], ['source', 'different-folder'].includes(retire) ? null : '/repo', retire);
    }
  }
});

test('equivalent restores coalesce and a failed restore remains retryable with the same saved origin', async () => {
  const first = deferred<any>();
  const calls: unknown[][] = [];
  const store = { records: new Map(['a', 'fork'].map((id) => [id, { meta: { worktreeOf: '/repo' } }])) };
  const guard = chatFolderGuard({
    chatProject: async () => '/wt/a/repo',
    state: () => ({ prefs: { worktreeRoot: '/wt' } }),
    chats: () => store,
    exists: () => false,
    restore: (...args: unknown[]) => (calls.push(args), calls.length === 1 ? first.promise : { ok: true, restored: false }),
  });
  const one = guard({ chatId: 'a' });
  const two = guard({ chatId: 'fork' });
  const failures = Promise.all([assert.rejects(one, /offline/), assert.rejects(two, /offline/)]);
  first.reject(new Error('offline'));
  await failures;
  await guard({ chatId: 'fork' });
  assert.deepEqual(calls, [
    ['/wt/a/repo', '/wt', '/repo', null],
    ['/wt/a/repo', '/wt', '/repo', null],
  ]);
});

test('missing optional metadata uses the holder fallback and a store reload supplies the current saved origin', async () => {
  let records = new Map<string, any>();
  let store = { records };
  const calls: unknown[][] = [];
  const guard = chatFolderGuard({
    chatProject: async () => '/wt/a/repo',
    state: () => null,
    chats: () => store,
    exists: () => false,
    restore: async (...args: unknown[]) => (calls.push(args), { ok: true, restored: false }),
  });
  await guard({ chatId: 'missing-record' });
  records.set('no-meta', {});
  await guard({ chatId: 'no-meta' });
  records.set('no-origin', { meta: {} });
  await guard({ chatId: 'no-origin' });
  records = new Map([['fork', { meta: { worktreeOf: '/current-repo' } }]]);
  store = { records };
  await guard({ chatId: 'fork' });
  assert.deepEqual(
    calls.map((args) => args[2]),
    [null, null, null, '/current-repo'],
  );
});

test('a source accepted before a later pending read is revalidated before any inferred origin is saved or restored', async () => {
  const slow = deferred<string>();
  const records = new Map<string, any>([
    ['fork', { meta: {} }],
    ['early', { meta: { worktreeOf: '/old' } }],
    ['slow', { meta: { worktreeOf: '/other' } }],
  ]);
  let saved = 0;
  const store = { records, patchMeta: () => (saved++, true) };
  const origins: unknown[] = [];
  const guard = chatFolderGuard({
    chatProject: (id: string) => (id === 'slow' ? slow.promise : Promise.resolve('/wt/a/repo')),
    chats: () => store,
    state: () => null,
    exists: () => false,
    restore: async (_cwd: string, _root: string, repo: unknown) => (origins.push(repo), { ok: true, restored: false }),
  });
  const pending = guard({ chatId: 'fork' });
  await tick();
  records.set('early', { meta: { worktreeOf: '/replacement' } });
  slow.resolve('/different-folder');
  await pending;
  assert.deepEqual(origins, [null]);
  assert.equal(saved, 0);
});

test('a folder read that finishes after its chat record changed cannot pair the old folder with the new repository', async () => {
  const folder = deferred<string>();
  const records = new Map([['fork', { meta: { worktreeOf: '/old-repository' } }]]);
  const store = { records };
  let restores = 0;
  const guard = chatFolderGuard({
    chatProject: () => folder.promise,
    state: () => null,
    chats: () => store,
    exists: () => false,
    restore: async () => (restores++, { ok: true, restored: false }),
  });
  const result = assert.rejects(guard({ chatId: 'fork' }), /project changed/);
  records.set('fork', { meta: { worktreeOf: '/new-repository' } });
  folder.resolve('/wt/old/repo');
  await result;
  assert.equal(restores, 0);
});

test('conflicting saved origins never share a successful restoration', async () => {
  const running = deferred<any>();
  const started = deferred<void>();
  const store = { records: new Map(['a', 'b'].map((id) => [id, { meta: { worktreeOf: `/repo-${id}` } }])) };
  const calls: unknown[][] = [];
  const guard = chatFolderGuard({
    chatProject: async () => '/wt/a/repo',
    state: () => null,
    chats: () => store,
    exists: () => false,
    restore: (...args: unknown[]) => (calls.push(args), started.resolve(), running.promise),
  });
  const first = guard({ chatId: 'a' });
  await started.promise;
  await assert.rejects(guard({ chatId: 'b' }), /different project/);
  running.resolve({ ok: true, restored: false });
  await first;
  assert.equal(calls.length, 1);
});

test('a folder recreated by Git is not ready for another send while its shared setup script is pending', async () => {
  for (const knownWaiter of [false, true]) {
    for (const exitCode of [0, 1]) {
      let exists = false;
      const entered = deferred<void>();
      const setup = deferred<any>();
      let restores = 0;
      const store = { records: new Map<string, any>() };
      const guard = chatFolderGuard({
        chatProject: async () => '/wt/a/repo',
        state: () => null,
        exists: () => exists,
        chats: () => store,
        restore: async () => {
          restores++;
          if (exists) return { ok: true, restored: false };
          exists = true;
          return { ok: true, restored: true, repo: '/repo', worktree: '/wt/a/repo' };
        },
        setupScript: () => 'setup',
        runScript: () => (entered.resolve(), setup.promise),
      });
      const first = guard({ chatId: 'a' });
      const firstResult = exitCode ? assert.rejects(first, /setup script failed/) : first;
      await entered.promise;
      if (knownWaiter) store.records.set('b', { meta: { worktreeOf: '/repo' } });
      let secondFinished = false;
      const second = guard({ chatId: 'b' }).then(() => {
        secondFinished = true;
      });
      const secondResult = exitCode ? assert.rejects(second, /setup script failed/) : second;
      await tick();
      assert.equal(secondFinished, false);
      setup.resolve({ exitCode, output: 'setup output' });
      await Promise.all([firstResult, secondResult]);
      assert.equal(secondFinished, exitCode === 0);
      assert.equal(restores, 1);
    }
  }
});

test('a retired chat cannot continue into or out of a shared restore, including a retry after failure', async () => {
  for (const phase of ['before', 'after', 'join', 'retry']) {
    const pending = deferred<any>();
    const started = deferred<void>();
    const records = new Map<string, any>([
      ['a', { meta: { worktreeOf: '/repo' } }],
      ['b', { meta: { worktreeOf: '/repo' } }],
    ]);
    if (phase === 'retry') records.clear();
    const store = { records };
    let calls = 0;
    const guard = chatFolderGuard({
      chatProject: async () => '/wt/a/repo',
      state: () => null,
      chats: () => store,
      exists: () => false,
      restore: () => (calls++, started.resolve(), pending.promise),
    });
    if (phase === 'before') {
      const attempt = guard({ chatId: 'b' });
      const result = assert.rejects(attempt, /project changed/);
      queueMicrotask(() => records.set('b', { meta: { worktreeOf: '/new' } }));
      await result;
      assert.equal(calls, 0);
      continue;
    }
    const first = guard({ chatId: 'a' });
    const firstResult =
      phase === 'after'
        ? assert.rejects(first, /project changed/)
        : phase === 'retry'
          ? assert.rejects(first, /project folder is gone/)
          : first;
    await started.promise;
    if (phase === 'retry') records.set('b', { meta: { worktreeOf: '/repo' } });
    const joining = phase === 'join' || phase === 'retry' ? guard({ chatId: 'b' }) : null;
    const joined = joining ? assert.rejects(joining, /project changed/) : Promise.resolve();
    await tick();
    records.set(phase === 'after' ? 'a' : 'b', { meta: { worktreeOf: '/new' } });
    if (phase === 'retry') pending.resolve({ ok: false, error: 'The project folder is gone' });
    else pending.resolve({ ok: true, restored: false });
    await Promise.all([firstResult, joined]);
    assert.equal(calls, 1);
  }
});
