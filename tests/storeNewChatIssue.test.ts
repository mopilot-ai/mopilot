// src/store/chatCreation.ts with an issue picked in the branch menu: it is read again when the chat starts, the chat's first message carries its quoted text for every harness, and the pick ends with the chat.
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;

const CONTEXT = 'This chat starts from GitHub issue #34 …';
const read = (over: object = {}) => ({
  ok: true,
  kind: 'issue',
  number: 34,
  title: 'Crash on save',
  url: 'https://github.com/acme/app/issues/34',
  state: 'OPEN',
  context: CONTEXT,
  ...over,
});
const pick = (branch: string | null = 'main') => ({ path: '/w/p', branch, issue: { number: 34, title: 'Crash on save' } });
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
  impl['git.issue'] = async () => read();
  impl['git.switchBranch'] = async () => ({ ok: true });
  impl['git.worktreeAdd'] = async (_cwd: string, o: any) => ({
    ok: true,
    path: '/wt/1',
    worktree: '/wt/1',
    branch: 'mopilot/1',
    repo: '/w/p',
    base: o.branch,
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

test('with Worktree on, the issue is read again, the worktree starts from the branch shown, and the first message carries the issue', async () => {
  S.setNewChatWorktree(true);
  set({ newChatBranch: pick('develop') });
  assert.equal(await S.sendMessage(null, 'Fix it'), true);
  assert.deepEqual(callsOf('git.issue'), [['/w/p', 34]]);
  assert.equal(callsOf('git.worktreeAdd')[0][1].branch, 'develop');
  assert.equal(callsOf('git.worktreeAdd')[0][1].checkout, undefined);
  assert.deepEqual(prefixes(), [CONTEXT]);
  assert.equal(callsOf('proxy.send')[0][1], 'Fix it');
  // carried once: the pick and the carry end with this chat
  assert.equal(st().newChatBranch, null);
  assert.deepEqual(st().handoffCarry, {});
});

test('without a worktree the chat runs in the folder as it is, or on a branch picked before the issue, carrying the issue', async () => {
  // no branch picked: nothing is switched (a detached HEAD stays as it is)
  set({ newChatBranch: pick(null) });
  assert.equal(await S.sendMessage(null, 'Fix it'), true);
  assert.deepEqual([callsOf('git.switchBranch'), callsOf('git.worktreeAdd')], [[], []]);
  assert.deepEqual(prefixes(), [CONTEXT]);
  set({ newChatBranch: pick('main') });
  await S.sendMessage(null, 'Fix it');
  assert.deepEqual(callsOf('git.switchBranch'), [['/w/p', 'main']]);
  // and with Worktree on and no branch picked, the worktree starts from origin's default, as with no pick at all
  S.setNewChatWorktree(true);
  set({ newChatBranch: pick(null) });
  await S.sendMessage(null, 'Fix it');
  assert.equal(callsOf('git.worktreeAdd')[0][1].branch, undefined);
});

test('a voice chat has no typed first message: the issue is neither read nor used up, and stays for the next chat', async () => {
  const p = pick();
  set({ newChatBranch: p });
  assert.equal(await S.createChatThread('Voice chat', { typed: false }), 'cx-/w/p');
  assert.deepEqual([callsOf('git.issue'), st().handoffCarry, st().newChatBranch], [[], {}, p]);
});

test('an issue that cannot be read again starts nothing, says why, and keeps the pick', async () => {
  S.setNewChatWorktree(true);
  for (const answer of [{ ok: false, error: 'acme/app has no issue #34.' }, read({ context: undefined })]) {
    impl['git.issue'] = async () => answer;
    const p = pick();
    set({ newChatBranch: p });
    assert.equal(await S.createChatThread('x'), null);
    assert.equal(
      lastToast(),
      `Failed to start chat: ${'error' in answer ? answer.error : 'GitHub returned incomplete issue data. Try again.'}`,
    );
    assert.equal(st().newChatBranch, p);
  }
  assert.deepEqual([callsOf('git.worktreeAdd'), callsOf('codex.startThread')], [[], []]);
});

test('a first message that is not sent keeps the issue for the next try, named on the chip as the issue', async () => {
  S.setNewChatWorktree(true);
  set({ newChatBranch: pick() });
  impl['proxy.send'] = async () => {
    throw new Error('journal unwritable');
  };
  assert.equal(await S.sendMessage(null, 'Fix it'), false);
  const [id] = Object.keys(st().handoffCarry);
  assert.deepEqual(st().handoffCarry[id], { text: CONTEXT, fromTitle: '#34 Crash on save', issue: true });
  impl['proxy.send'] = async () => ({ action: 'started', id: 'turn' });
  assert.equal(await S.sendMessage(id, 'Fix it'), true);
  assert.equal(prefixes().at(-1), CONTEXT);
});

test('a picked workspace wins: the issue is neither read nor carried', async () => {
  impl['git.worktreeInfo'] = async (p: string) => ({ path: p, repo: '/w/p', branch: 'feat', adopted: true });
  set({ newChatBranch: pick(), newChatWorkspace: { root: '/w/p', path: '/c/tokyo', name: 'tokyo' } });
  assert.equal(await S.createChatThread('x'), 'cx-/c/tokyo');
  assert.deepEqual(callsOf('git.issue'), []);
  assert.deepEqual(st().handoffCarry, {});
});

test('Claude Code and a basic harness carry the issue too', async () => {
  S.setNewChatWorktree(true);
  set({
    newChatBranch: pick(),
    prefs: { ...st().prefs, defaultHarness: 'claude' },
    claude: { status: { state: 'apikey' } as any, models: [] },
  });
  const claude = await S.createChatThread('x');
  assert.equal(st().handoffCarry[claude!].text, CONTEXT);
  set({
    newChatBranch: pick(),
    basicHarnesses: [{ id: 'kimi', state: 'admitted' }] as any,
    prefs: { ...st().prefs, defaultHarness: 'acp:kimi' },
  });
  impl['acp.startAcpThread'] = (o: any) => `acp:${o.harness}:${o.cwd}`;
  assert.equal(await S.createChatThread('x'), 'acp:kimi:/wt/1');
  assert.equal(st().handoffCarry['acp:kimi:/wt/1'].text, CONTEXT);
});
