// Fork and side-chat entrypoints preserve the managed workspace's repository even after its holder marker is removed.
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, impl, resetAll } from './support/store-harness.ts';
import { deferred } from './support/async-scenarios.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();
const state = store.useStore.getState;
const set = store.useStore.setState;

beforeEach(() => {
  resetState();
  resetAll();
});

test('whole and message forks on either harness inherit the repository needed to restore their folder', async () => {
  for (const parent of ['codex-parent', 'claude:parent']) {
    set({
      worktreeOf: { [parent]: '/repo' },
      runtime: { [parent]: { turns: [{ id: 'T1', items: [] }] } as any },
    });
    impl['run.runSemantic'] = async (_chat: string, _sem: string, turn: string) => ({ ok: true, value: `${parent}-fork-${turn}` });
    for (const turn of [undefined, 'T1']) {
      const id = await store.forkThread(parent, turn);
      assert.equal(state().worktreeOf[id!], '/repo');
    }
  }
});

test('a switched fork and both side-chat families retain their workspace repository', async () => {
  set({
    worktreeOf: { switched: '/repo', codex: '/codex-repo', 'claude:parent': '/claude-repo' },
    segments: {
      switched: [
        { harness: 'codex', nativeId: 'switched', start: 0, count: 1 },
        { harness: 'codex', nativeId: 'native-two', start: 1, count: null },
      ],
    } as any,
  });
  impl['codex.fork'] = async (p: any) => ({ thread: { id: `${p.threadId}-fork`, cwd: '/wt/workspace/repo' } });
  impl['api.threadRename'] = async () => ({});
  const switched = await store.forkThread('switched');
  assert.equal(state().worktreeOf[switched!], '/repo');
  const codex = await store.openSideChat('codex');
  assert.equal(state().worktreeOf[codex!], '/codex-repo');
  impl['claude.openClaudeSideChat'] = () => 'claude:side';
  const claude = await store.openSideChat('claude:parent');
  assert.equal(state().worktreeOf[claude!], '/claude-repo');
});

test('overlapping forks combine their captured origins even when the parents change and completion reverses', async () => {
  set({ worktreeOf: { a: '/repo-a', b: '/repo-b', other: '/keep' } });
  const a = deferred<any>();
  const b = deferred<any>();
  impl['run.runSemantic'] = (id: string) => (id === 'a' ? a.promise : b.promise);
  const first = store.forkThread('a');
  const second = store.forkThread('b');
  set({ worktreeOf: { a: '/replacement', b: '/replacement', other: '/keep' } });
  b.resolve({ ok: true, value: 'fork-b' });
  await second;
  a.resolve({ ok: true, value: '__proto__' });
  await first;
  assert.equal(state().worktreeOf['fork-b'], '/repo-b');
  assert.equal(Object.getOwnPropertyDescriptor(state().worktreeOf, '__proto__')?.value, '/repo-a');
  assert.equal(state().worktreeOf.other, '/keep');
});

test('plain folders, refused forks and rejected forks do not invent or overwrite a repository', async () => {
  set({ worktreeOf: { keep: '/keep', failed: '/repo' } });
  impl['run.runSemantic'] = async () => ({ ok: true, value: 'plain-fork' });
  assert.equal(await store.forkThread('plain'), 'plain-fork');
  impl['run.runSemantic'] = async () => ({ ok: false, state: 'absent', why: null });
  assert.equal(await store.forkThread('failed'), undefined);
  impl['run.runSemantic'] = async () => {
    throw new Error('fork failed');
  };
  await assert.rejects(store.forkThread('failed'), /fork failed/);
  assert.deepEqual(state().worktreeOf, { keep: '/keep', failed: '/repo' });
});

test('a reused side chat retains its original repository after the parent context changes', async () => {
  set({ worktreeOf: { parent: '/repo', side: '/original' } });
  impl['run.runSemantic'] = async () => ({ ok: true, value: 'side' });
  assert.equal(await store.forkThread('parent'), 'side');
  assert.equal(state().worktreeOf.side, '/original');
});
