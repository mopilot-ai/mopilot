// src/store/store.ts: the new chat's Worktree choice (the saved default and a draft's own), its branch and where it starts.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();
const S = store;
const st = () => S.useStore.getState();
const set = S.useStore.setState;

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  impl['session.snapshot'] = async () => null;
});

test('new chat defaults reset, and a top-level new chat is projectless', () => {
  set({
    newChatTemporary: true,
    newChatCloudEnv: { id: 'e', label: 'E' },
    newChatWorktree: true,
    newChatWorktreeHintOff: '/x',
    newChatBranch: { path: '/x', branch: 'b' },
    newChatProjectId: 'p',
    newChatCwd: '/x',
  });
  S.resetNewChatDefaults();
  S.clearNewChatProject();
  const s = st();
  assert.deepEqual(
    [s.newChatTemporary, s.newChatCloudEnv, s.newChatWorktree, s.newChatWorktreeHintOff, s.newChatBranch, s.newChatProjectId, s.newChatCwd],
    [false, null, null, null, null, 'none', null],
  );
});

test("the Worktree switch's setting is the saved default new chats start with; a draft's own choice wins until it ends", () => {
  set({ newChatWorktree: null, prefs: { ...st().prefs, worktreeDefault: false } });
  assert.equal(S.newChatWorktreeOn(), false, 'off at first');
  S.setNewChatWorktree(true);
  assert.equal(st().prefs.worktreeDefault, true);
  assert.equal(S.newChatWorktreeOn(), true);
  // the suggestion's choice for this draft, then a new chat from the tray: back to the saved default
  set({ newChatWorktree: false });
  assert.equal(S.newChatWorktreeOn(), false);
  S.resetNewChatDefaults();
  assert.equal(S.newChatWorktreeOn(), true, 'the saved default survives the reset');
  // toggling clears the draft's own choice
  set({ newChatWorktree: true });
  S.setNewChatWorktree(false);
  assert.deepEqual([st().newChatWorktree, st().prefs.worktreeDefault, S.newChatWorktreeOn()], [null, false, false]);
  // a saved value that isn't true (an older profile without it) is off
  set({ prefs: { ...st().prefs, worktreeDefault: 'yes' as any } });
  assert.equal(S.newChatWorktreeOn(), false);
  set({ prefs: { ...st().prefs, worktreeDefault: false } });
});

test('createChatThread: the picked branch is the worktree base, or is checked out in place without a worktree', async () => {
  set({
    conn: 'ready',
    home: '/home/me',
    toasts: [],
    newChatCwd: null,
    newChatTemporary: false,
    prefs: { ...st().prefs, defaultHarness: 'codex' } as any,
  });
  set({ newChatProjectId: 'p', savedProjects: [{ id: 'p', name: 'P', roots: [{ path: '/w/p' }], source: 'codex', codexId: 'cxp' }] });
  impl['codex.startThread'] = async (p: any) => ({ thread: { id: `cx-${p.cwd}`, cwd: p.cwd } });
  impl['fs.readText'] = async () => '';
  impl['git.worktreeAdd'] = async () => ({ ok: true, path: '/wt/r', branch: 'mopilot/r', repo: '/w/p', worktree: '/wt/r' });
  impl['git.switchBranch'] = async () => ({ ok: true });
  S.setNewChatWorktree(true);
  set({ newChatBranch: { path: '/w/p', branch: 'release' } });
  assert.equal(await S.createChatThread('x'), 'cx-/wt/r');
  assert.deepEqual(callsOf('git.worktreeAdd').at(-1), [
    '/w/p',
    { prefix: 'mopilot/', root: '/home/me/.mopilot/worktrees', branch: 'release' },
  ]);
  assert.equal(callsOf('git.switchBranch').length, 0);
  // without a worktree the project folder is switched to it first
  S.setNewChatWorktree(false);
  assert.equal(await S.createChatThread('x'), 'cx-/w/p');
  assert.deepEqual(callsOf('git.switchBranch').at(-1), ['/w/p', 'release']);
  impl['git.switchBranch'] = async () => ({
    ok: false,
    error: 'Can\'t switch to "release": there are uncommitted changes on "main" in /w/p. Commit or stash them, or turn on Worktree.',
  });
  assert.equal(await S.createChatThread('x'), null);
  assert.equal(
    st().toasts.at(-1)!.text,
    'Failed to start chat: Can\'t switch to "release": there are uncommitted changes on "main" in /w/p. Commit or stash them, or turn on Worktree.',
  );
  // a branch picked for another folder, or none: nothing is switched and the worktree uses the default
  const switches = callsOf('git.switchBranch').length;
  set({ newChatBranch: { path: '/elsewhere', branch: 'x' } });
  assert.equal(await S.createChatThread('x'), 'cx-/w/p');
  set({ newChatBranch: null });
  S.setNewChatWorktree(true);
  await S.createChatThread('x');
  assert.equal(callsOf('git.switchBranch').length, switches);
  assert.deepEqual(callsOf('git.worktreeAdd').at(-1), ['/w/p', { prefix: 'mopilot/', root: '/home/me/.mopilot/worktrees' }]);
  // a folder that can't hold a worktree: the chat starts in the folder itself, on the picked branch
  impl['git.worktreeAdd'] = async () => ({ ok: false, unsupported: true, error: "This folder isn't a git repository" });
  set({ newChatBranch: { path: '/w/p', branch: 'release' }, toasts: [] });
  impl['git.switchBranch'] = async () => ({ ok: true });
  assert.equal(await S.createChatThread('x'), 'cx-/w/p');
  assert.deepEqual(callsOf('git.switchBranch').at(-1), ['/w/p', 'release']);
  assert.equal(st().worktreeOf['cx-/w/p'], undefined);
  assert.deepEqual(st().toasts, [], 'the switch already says why; starting is not a failure');
  set({ newChatBranch: null });
  S.setNewChatWorktree(false);
});
