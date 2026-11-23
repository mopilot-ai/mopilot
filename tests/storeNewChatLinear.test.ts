// src/store/chatCreation.ts with a Linear issue picked in the branch menu: it is read again when the chat starts, a worktree works on Linear's suggested branch, the first message carries its quoted text for every harness, and the pick ends with the chat.
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;

const CONTEXT = 'This chat starts from Linear issue ENG-12 …';
const read = (over: object = {}) => ({
  ok: true,
  kind: 'linear',
  key: 'ENG-12',
  title: 'Fix login',
  url: 'https://linear.app/acme/issue/ENG-12/fix-login',
  state: 'Todo',
  done: false,
  branch: 'pat/eng-12-fix-login',
  context: CONTEXT,
  ...over,
});
const pick = (branch: string | null = null) => ({
  path: '/w/p',
  branch,
  linear: { key: 'ENG-12', title: 'Fix login', branch: 'pat/eng-12-fix-login' },
});
const lastToast = () => st().toasts.at(-1)!.text;
const prefixes = () => callsOf('proxy.send').map((a) => a[3].prefix);

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  impl['session.snapshot'] = async () => null;
  impl['linear.issue'] = async () => read();
  impl['git.switchBranch'] = async () => ({ ok: true });
  impl['git.worktreeAdd'] = async (_cwd: string, o: any) => ({
    ok: true,
    path: '/wt/1',
    worktree: '/wt/1',
    branch: o.newBranch ?? 'mopilot/1',
    repo: '/w/p',
  });
  impl['codex.startThread'] = async (p: any) => ({ thread: { id: `cx-${p.cwd}`, cwd: p.cwd } });
  impl['proxy.send'] = async () => ({ action: 'started', id: 'turn' });
  set({
    conn: 'ready',
    home: '/home/me',
    newChatProjectId: 'p',
    savedProjects: [{ id: 'p', name: 'P', roots: [{ path: '/w/p' }], source: 'codex', codexId: 'cxp' }],
  });
});

test('with Worktree on, the issue is read again, the worktree is on Linear’s branch, and the first message carries the issue', async () => {
  S.setNewChatWorktree(true);
  set({ newChatBranch: pick() });
  assert.equal(await S.sendMessage(null, 'Fix it'), true);
  assert.deepEqual(callsOf('linear.issue'), [['ENG-12']]);
  assert.equal(callsOf('git.worktreeAdd')[0][1].newBranch, 'pat/eng-12-fix-login');
  assert.equal(lastToast(), 'Working in worktree on pat/eng-12-fix-login');
  assert.deepEqual(prefixes(), [CONTEXT]);
  assert.equal(st().newChatBranch, null);
  assert.deepEqual(st().handoffCarry, {});
});

test('an issue Linear suggests no branch for gets the usual one; without a worktree the folder is used as it is', async () => {
  S.setNewChatWorktree(true);
  impl['linear.issue'] = async () => read({ branch: null });
  set({ newChatBranch: pick() });
  await S.sendMessage(null, 'Fix it');
  assert.equal(callsOf('git.worktreeAdd')[0][1].newBranch, undefined);
  S.setNewChatWorktree(false);
  set({ newChatBranch: pick() });
  await S.sendMessage(null, 'Fix it');
  assert.equal(callsOf('git.worktreeAdd').length, 1);
  assert.deepEqual(callsOf('git.switchBranch'), []);
  assert.deepEqual(prefixes(), [CONTEXT, CONTEXT]);
});

test('an issue that can’t be read again starts nothing, says why, and keeps the pick; a voice chat neither reads nor uses it', async () => {
  S.setNewChatWorktree(true);
  for (const answer of [{ ok: false, error: 'Linear refused the API key: it was revoked or is wrong.' }, read({ context: undefined })]) {
    impl['linear.issue'] = async () => answer;
    const p = pick();
    set({ newChatBranch: p });
    assert.equal(await S.createChatThread('x'), null);
    assert.equal(
      lastToast(),
      `Failed to start chat: ${'error' in answer ? answer.error : 'Linear returned incomplete issue data. Try again.'}`,
    );
    assert.equal(st().newChatBranch, p);
  }
  impl['linear.issue'] = async () => read();
  const p = pick();
  set({ newChatBranch: p });
  assert.ok(await S.createChatThread('Voice chat', { typed: false }));
  assert.deepEqual(callsOf('linear.issue').length, 2);
  assert.equal(st().newChatBranch, p);
});

test('Claude Code and a basic harness carry the Linear issue too, named on the chip by its key', async () => {
  S.setNewChatWorktree(true);
  set({
    newChatBranch: pick(),
    prefs: { ...st().prefs, defaultHarness: 'claude' },
    claude: { status: { state: 'apikey' } as any, models: [] },
  });
  const claude = await S.createChatThread('x');
  assert.deepEqual(st().handoffCarry[claude!], { text: CONTEXT, fromTitle: 'ENG-12 Fix login', issue: true });
  set({
    newChatBranch: pick(),
    basicHarnesses: [{ id: 'kimi', state: 'admitted' }] as any,
    prefs: { ...st().prefs, defaultHarness: 'acp:kimi' },
  });
  impl['acp.startAcpThread'] = (o: any) => `acp:${o.harness}:${o.cwd}`;
  assert.equal(await S.createChatThread('x'), 'acp:kimi:/wt/1');
  assert.equal(st().handoffCarry['acp:kimi:/wt/1'].text, CONTEXT);
});
