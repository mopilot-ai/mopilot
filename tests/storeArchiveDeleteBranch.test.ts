// src/store/actions.ts archiveThread with "Delete branch on archive" (src/store/projects.ts retireWorktree): main removes the worktree and its branch after the cleanup script, says why when it keeps them, and Undo restores the chat and its worktree, whose branch main makes again.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resolvedEnvironment, resetAll, flush, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const { retireWorktree } = await import('../src/store/projects.ts');
const texts = () => st().toasts.map((t) => t.text);

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  impl['session.snapshot'] = async () => null;
  impl['git.worktreeInfo'] = async () => ({ repo: '/w/repo', path: '/wt/a' });
  impl['env.resolve'] = async () => resolvedEnvironment({ cleanup: 'down' });
  impl['env.runScript'] = async () => ({ exitCode: 0, output: '' });
  impl['api.threadList'] = async () => ({ data: [], nextCursor: null });
  impl['api.threadArchive'] = async () => ({});
  impl['git.worktreeArchive'] = async () => ({ ok: true, removed: true, deleted: { branch: 'mopilot/a1' } });
  impl['git.worktreeRestore'] = async () => ({ ok: true, restored: false });
  impl['api.threadUnarchive'] = async () => ({ thread: { id: 'a', name: 'Alpha' } });
  set({ conn: 'ready', home: '/home/me', threads: { a: { id: 'a', name: 'Alpha', cwd: '/wt/a' } as any }, threadOrder: ['a'] });
});

test('with the setting on, an archive deletes the branch after the cleanup script, and Undo restores the worktree', async () => {
  set({ prefs: { ...st().prefs, deleteBranchOnArchive: true } });
  await S.archiveThread('a');
  await flush();
  assert.deepEqual(callsOf('env.runScript'), [['/wt/a', 'down']]);
  assert.deepEqual(callsOf('git.worktreeArchive'), [['/wt/a']]);
  assert.equal(callsOf('git.worktreePrune').length, 1);
  // the worktree is restored as for any unarchive: main makes the branch again from its record
  impl['git.worktreeRestore'] = async () => ({ ok: true, restored: true, worktree: '/wt/a', branch: 'mopilot/a1', repo: '/w/repo' });
  st().toasts[0].action!.run();
  await flush();
  assert.equal(callsOf('git.worktreeRestore')[0][0], '/wt/a');
  assert.deepEqual(st().threadOrder, ['a']);
  assert.ok(texts().includes('Restored worktree on mopilot/a1'));
});

test('what main keeps, and why, is said, and a refusal says why too', async () => {
  set({ prefs: { ...st().prefs, deleteBranchOnArchive: true } });
  impl['git.worktreeArchive'] = async () => ({
    ok: true,
    removed: false,
    kept: 'Kept the worktree and its branch: x has uncommitted changes.',
  });
  await S.archiveThread('a');
  await flush();
  assert.ok(texts().includes('Kept the worktree and its branch: x has uncommitted changes.'));
  impl['git.worktreeArchive'] = async () => ({ ok: false, error: 'Not a MoPilot worktree.' });
  assert.equal(await retireWorktree('/wt/a', { archive: true }), undefined);
  assert.ok(texts().includes("Couldn't delete this chat's branch: Not a MoPilot worktree."));
});

test('the setting off, a deleted chat, another open chat in the folder, or an incomplete chat list deletes no branch', async () => {
  await retireWorktree('/wt/a', { archive: true });
  set({ prefs: { ...st().prefs, deleteBranchOnArchive: true } });
  await retireWorktree('/wt/a');
  set({ threads: { b: { id: 'b', cwd: '/wt/a/sub' } as any } });
  impl['api.threadList'] = async () => ({ data: [{ id: 'b', cwd: '/wt/a/sub' }], nextCursor: null });
  await retireWorktree('/wt/a', { archive: true });
  impl['api.threadList'] = () => Promise.reject(new Error('down'));
  await retireWorktree('/wt/a', { archive: true });
  assert.deepEqual(callsOf('git.worktreeArchive'), []);
});
