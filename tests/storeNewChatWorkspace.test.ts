// src/store/chatCreation.ts: a new chat in a workspace brought over in place runs there as it is, grouped under its project, and makes or switches nothing.
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
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
  impl['git.worktreeInfo'] = async (p: string) => ({ path: p, repo: '/w/p', branch: 'feat', adopted: true });
  impl['codex.startThread'] = async (p: any) => ({ thread: { id: `cx-${p.cwd}`, cwd: p.cwd } });
  set({
    conn: 'ready',
    home: '/home/me',
    newChatProjectId: 'p',
    savedProjects: [{ id: 'p', name: 'P', roots: [{ path: '/w/p' }], source: 'codex', codexId: 'cxp' }],
  });
});

test('the chat starts in the picked workspace: no worktree is made and no branch switched, even with both asked for', async () => {
  S.setNewChatWorktree(true);
  set({ newChatBranch: { path: '/w/p', branch: 'main' }, newChatWorkspace: { root: '/w/p', path: '/c/tokyo', name: 'tokyo' } });
  assert.equal(await S.createChatThread('x'), 'cx-/c/tokyo');
  assert.deepEqual([callsOf('git.worktreeAdd'), callsOf('git.switchBranch')], [[], []]);
  // grouped under its project, and the pick ends with the draft
  assert.equal(st().worktreeOf['cx-/c/tokyo'], '/w/p');
  assert.equal(st().newChatWorkspace, null);
  assert.ok(st().toasts.some((t: any) => t.text === 'Working in tokyo'));
});

test('a pick made for another folder is not this chat’s, and one changed while the chat starts stays for the next', async () => {
  const other = { root: '/w/other', path: '/c/oslo', name: 'oslo' };
  set({ newChatWorkspace: other });
  assert.equal(await S.createChatThread('x'), 'cx-/w/p');
  assert.equal(st().worktreeOf['cx-/w/p'], undefined);
  const next = { root: '/w/p', path: '/c/lima', name: 'lima' };
  set({ newChatWorkspace: { root: '/w/p', path: '/c/tokyo', name: 'tokyo' } });
  impl['codex.startThread'] = async (p: any) => {
    set({ newChatWorkspace: next });
    return { thread: { id: `cx-${p.cwd}`, cwd: p.cwd } };
  };
  assert.equal(await S.createChatThread('y'), 'cx-/c/tokyo');
  assert.equal(st().newChatWorkspace, next);
  // a fresh draft has none
  S.resetNewChatDefaults();
  assert.equal(st().newChatWorkspace, null);
});

test('a workspace that is gone when the chat is sent starts nothing: the reason is said and the pick dropped', async () => {
  const pick = { root: '/w/p', path: '/c/tokyo', name: 'tokyo' };
  // no longer a worktree; a managed worktree at that path; a folder inside another adopted one
  for (const info of [null, { path: '/c/tokyo', repo: '/w/p', branch: 'b' }, { path: '/c', repo: '/w/p', branch: 'b', adopted: true }]) {
    set({ newChatWorkspace: pick, toasts: [] });
    impl['git.worktreeInfo'] = async () => info;
    assert.equal(await S.createChatThread('x'), null);
    assert.deepEqual(callsOf('codex.startThread'), []);
    assert.equal(st().toasts.at(-1)!.text, 'Failed to start chat: The workspace tokyo is gone. Pick where to run the chat again.');
    assert.equal(st().newChatWorkspace, null);
  }
  // a pick changed while that was checked is the next draft's and stays
  const next = { root: '/w/p', path: '/c/lima', name: 'lima' };
  set({ newChatWorkspace: pick });
  impl['git.worktreeInfo'] = async () => (set({ newChatWorkspace: next }), null);
  assert.equal(await S.createChatThread('x'), null);
  assert.equal(st().newChatWorkspace, next);
});

test('what the draft offers and warms follows the pick: the workspace’s files and commands, and a session started there', async () => {
  const P = await import('../src/store/prewarm.ts');
  const { codexThreadParams } = await import('../src/store/projects.ts');
  set({ route: { name: 'home' } });
  assert.equal(S.currentCwdForNewChat(), '/w/p');
  set({ newChatWorkspace: { root: '/w/other', path: '/c/oslo', name: 'oslo' } });
  assert.equal(S.currentCwdForNewChat(), '/w/p');
  // with Worktree on too: the workspace is there already, so its folder is known now
  S.setNewChatWorktree(true);
  set({ newChatWorkspace: { root: '/w/p', path: '/c/tokyo', name: 'tokyo' } });
  assert.equal(S.currentCwdForNewChat(), '/c/tokyo');
  assert.deepEqual(P.prewarmSpec(), { kind: 'codex', params: codexThreadParams(st().prefs, { cwd: '/c/tokyo', projectId: 'cxp' }) });
  // a folder outside any project has workspaces of its own
  set({ newChatCwd: '/else', newChatProjectId: null, newChatWorkspace: { root: '/else', path: '/c/oslo', name: 'oslo' } });
  assert.deepEqual(P.prewarmSpec(), { kind: 'codex', params: codexThreadParams(st().prefs, { cwd: '/c/oslo', projectId: null }) });
  set({ newChatCwd: null, newChatProjectId: 'p', newChatWorkspace: { root: '/w/p', path: '/c/tokyo', name: 'tokyo' } });
  // Claude Code is warmed in, and started in, the workspace
  set({ prefs: { ...st().prefs, defaultHarness: 'claude' }, claude: { status: { state: 'apikey' } as any, models: [] } });
  assert.deepEqual(P.prewarmSpec(), { kind: 'claude', cwd: '/c/tokyo' });
  impl['session.prewarmTake'] = async () => ({ id: 'sid-warm' });
  const id = await S.createChatThread('x');
  assert.equal(callsOf('claude.startClaudeThread').at(-1)![0].cwd, '/c/tokyo');
  assert.equal(st().worktreeOf[id!], '/w/p');
  assert.deepEqual(callsOf('session.prewarmTake').at(-1), [{ kind: 'claude', cwd: '/c/tokyo' }]);
  // and so is a basic harness's chat
  set({
    newChatWorkspace: { root: '/w/p', path: '/c/tokyo', name: 'tokyo' },
    basicHarnesses: [{ id: 'kimi', state: 'admitted' }] as any,
    prefs: { ...st().prefs, defaultHarness: 'acp:kimi' },
  });
  impl['acp.startAcpThread'] = (o: any) => `acp:${o.harness}:${o.cwd}`;
  assert.equal(await S.createChatThread('x'), 'acp:kimi:/c/tokyo');
  assert.equal(st().worktreeOf['acp:kimi:/c/tokyo'], '/w/p');
});
