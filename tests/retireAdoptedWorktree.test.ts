// src/store/projects.ts retireWorktree: a chat's worktree that was adopted in place is left alone when the chat is archived or deleted.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, bootImpls, resolvedEnvironment } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();
const { retireWorktree } = await import('../src/store/projects.ts');

before(async () => {
  bootImpls();
  await store.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  impl['session.snapshot'] = async () => null;
});

test('an adopted worktree gets no cleanup script and starts no prune; one MoPilot made still gets both', async () => {
  store.useStore.setState({ home: '/home/me', threads: {} });
  impl['api.threadList'] = async () => ({ data: [], nextCursor: null });
  // the project's cleanup script, as main resolves it (environment.toml, else Conductor's files)
  impl['env.resolve'] = async () => resolvedEnvironment({ source: 'environment', cleanup: 'down' });
  impl['env.runScript'] = async () => ({ exitCode: 0, output: '' });
  // it stays where it is, and the tool that made it may still use it
  impl['git.worktreeInfo'] = async () => ({ repo: '/w/repo', path: '/conductor/workspaces/app/tokyo', adopted: true });
  await retireWorktree('/conductor/workspaces/app/tokyo');
  assert.equal(callsOf('env.runScript').length, 0);
  assert.equal(callsOf('git.worktreePrune').length, 0);
  impl['git.worktreeInfo'] = async () => ({ repo: '/w/repo', path: '/wt/x' });
  await retireWorktree('/wt/x');
  assert.deepEqual(callsOf('env.runScript'), [['/wt/x', 'down']]);
  assert.equal(callsOf('git.worktreePrune').length, 1);
});
