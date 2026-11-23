// src/store/projects.ts noteWorktreeCopy: a worktree that did not get all of its repository's ignored files says so once; one that did says nothing.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, impl, resolvedEnvironment } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();

test('the copy notice is shown as an error; no copy result and an empty notice show nothing', () => {
  resetState();
  const copy = { copied: [], skipped: [], problem: null, notice: '' };
  S.noteWorktreeCopy(undefined);
  S.noteWorktreeCopy(copy);
  assert.deepEqual(S.useStore.getState().toasts, []);
  S.noteWorktreeCopy({ ...copy, notice: 'Not copied into the worktree: .env (not a regular file)' });
  assert.deepEqual(
    S.useStore.getState().toasts.map((t: any) => [t.text, t.kind]),
    [['Not copied into the worktree: .env (not a regular file)', 'error']],
  );
});

test('a new worktree that did not get every file says so before its setup runs', async () => {
  resetState();
  const copy = { copied: ['.env'], skipped: [{ path: 'big.env', reason: 'too large to copy' }], problem: null };
  impl['git.worktreeAdd'] = async () => ({
    ok: true,
    path: '/wt/a/p',
    worktree: '/wt/a/p',
    branch: 'mopilot/a',
    repo: '/w/p',
    copy: { ...copy, notice: 'Not copied into the worktree: big.env (too large to copy)' },
  });
  impl['env.resolve'] = async () => resolvedEnvironment({});
  assert.deepEqual(await S.newWorktree('/w/p'), { path: '/wt/a/p', branch: 'mopilot/a' });
  assert.deepEqual(
    S.useStore.getState().toasts.map((t: any) => t.text),
    ['Not copied into the worktree: big.env (too large to copy)'],
  );
});
