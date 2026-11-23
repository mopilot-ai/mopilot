// src/store/chatCreation.ts with a pull request picked in the branch menu: it is fetched when the chat starts, its worktree works on its branch for every harness, and without a worktree origin's branch is switched to while a fork's is refused.
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;

const fetched = (over: object = {}) => ({
  ok: true,
  number: 12,
  title: 'Fix the thing',
  url: 'https://github.com/acme/app/pull/12',
  state: 'OPEN',
  base: 'main',
  head: 'fix-thing',
  fork: false,
  own: true,
  checkout: 'fix-thing',
  ...over,
});
const pick = (fork = false, own = !fork) => ({
  path: '/w/p',
  branch: fork ? 'theirs' : 'fix-thing',
  pullRequest: { number: 12, title: 'Fix the thing', fork, own },
});
const lastToast = () => st().toasts.at(-1)!.text;

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  impl['session.snapshot'] = async () => null;
  impl['git.fetchPullRequest'] = async () => fetched();
  impl['git.switchBranch'] = async () => ({ ok: true });
  impl['git.worktreeAdd'] = async (_cwd: string, o: any) => ({
    ok: true,
    path: `/wt/${o.checkout ?? 'new'}`,
    worktree: `/wt/${o.checkout ?? 'new'}`,
    branch: o.checkout ?? 'mopilot/1234',
    repo: '/w/p',
  });
  impl['codex.startThread'] = async (p: any) => ({ thread: { id: `cx-${p.cwd}`, cwd: p.cwd } });
  set({
    conn: 'ready',
    home: '/home/me',
    newChatProjectId: 'p',
    savedProjects: [{ id: 'p', name: 'P', roots: [{ path: '/w/p' }], source: 'codex', codexId: 'cxp' }],
  });
});

test('with Worktree on, the pull request is fetched again and its worktree checks out its branch, based on what it merges into', async () => {
  S.setNewChatWorktree(true);
  set({ newChatBranch: pick() });
  assert.equal(await S.createChatThread('x'), 'cx-/wt/fix-thing');
  assert.deepEqual(callsOf('git.fetchPullRequest'), [['/w/p', 12]]);
  const [cwd, opts] = callsOf('git.worktreeAdd')[0];
  assert.equal(cwd, '/w/p');
  assert.deepEqual([opts.branch, opts.checkout, opts.pullRequest], ['main', 'fix-thing', undefined]);
  assert.equal(st().worktreeOf['cx-/wt/fix-thing'], '/w/p');
  assert.equal(lastToast(), 'Working in worktree on fix-thing');
});

test('a fork’s pull request names itself to worktree add, whose fetched head it checks out on pr/<n>', async () => {
  S.setNewChatWorktree(true);
  set({ newChatBranch: pick(true) });
  impl['git.fetchPullRequest'] = async () => fetched({ fork: true, own: false, head: 'theirs', checkout: 'pr/12' });
  assert.equal(await S.createChatThread('x'), 'cx-/wt/pr/12');
  const opts = callsOf('git.worktreeAdd')[0][1];
  assert.deepEqual([opts.branch, opts.checkout, opts.pullRequest], ['main', 'pr/12', 12]);
});

test('without a worktree, origin’s pull request branch is switched to in the folder; a copy is refused with why, before any fetch', async () => {
  set({ newChatBranch: pick() });
  assert.equal(await S.createChatThread('x'), 'cx-/w/p');
  assert.deepEqual(callsOf('git.switchBranch'), [['/w/p', 'fix-thing']]);
  assert.deepEqual(callsOf('git.worktreeAdd'), []);
  for (const [p, why] of [
    [pick(true), 'it comes from a fork'],
    [pick(false, false), 'it is no longer open, so its branch may be gone'],
  ] as const) {
    set({ newChatBranch: p });
    assert.equal(await S.createChatThread('x'), null);
    assert.equal(lastToast(), `Failed to start chat: Turn on Worktree to work on #12: ${why}.`);
    // the refused pick stays, so turning Worktree on is all it takes
    assert.equal(st().newChatBranch, p);
  }
  assert.equal(callsOf('git.fetchPullRequest').length, 1);
  // one that closed since it was picked is refused once fetched
  set({ newChatBranch: pick() });
  impl['git.fetchPullRequest'] = async () => fetched({ state: 'MERGED', own: false, checkout: 'pr/12' });
  assert.equal(await S.createChatThread('x'), null);
  assert.equal(lastToast(), 'Failed to start chat: Turn on Worktree to work on #12: it is no longer open, so its branch may be gone.');
  assert.equal(callsOf('git.switchBranch').length, 1);
});

test('a started chat ends its pull request pick (its branch is in use now); a plain branch pick, or one changed meanwhile, stays', async () => {
  S.setNewChatWorktree(true);
  set({ newChatBranch: pick() });
  await S.createChatThread('x');
  assert.equal(st().newChatBranch, null);
  const plain = { path: '/w/p', branch: 'feature' };
  set({ newChatBranch: plain });
  await S.createChatThread('x');
  assert.equal(st().newChatBranch, plain);
  set({ newChatBranch: pick() });
  impl['codex.startThread'] = async (p: any) => {
    set({ newChatBranch: plain });
    return { thread: { id: `cx-${p.cwd}`, cwd: p.cwd } };
  };
  await S.createChatThread('x');
  assert.equal(st().newChatBranch, plain);
});

test('a picked workspace wins: the pull request is neither fetched nor used', async () => {
  impl['git.worktreeInfo'] = async (p: string) => ({ path: p, repo: '/w/p', branch: 'feat', adopted: true });
  S.setNewChatWorktree(true);
  set({ newChatBranch: pick(true), newChatWorkspace: { root: '/w/p', path: '/c/tokyo', name: 'tokyo' } });
  assert.equal(await S.createChatThread('x'), 'cx-/c/tokyo');
  assert.deepEqual([callsOf('git.fetchPullRequest'), callsOf('git.worktreeAdd')], [[], []]);
});

test('a pull request that cannot be fetched starts nothing and says why', async () => {
  S.setNewChatWorktree(true);
  set({ newChatBranch: pick() });
  impl['git.fetchPullRequest'] = async () => ({ ok: false, error: 'acme/app has no pull request #12.' });
  assert.equal(await S.createChatThread('x'), null);
  assert.equal(lastToast(), 'Failed to start chat: acme/app has no pull request #12.');
  assert.deepEqual([callsOf('git.worktreeAdd'), callsOf('codex.startThread')], [[], []]);
});

test('a plain branch pick fetches no pull request; a pull request picked for another folder is not this chat’s', async () => {
  S.setNewChatWorktree(true);
  set({ newChatBranch: { path: '/w/p', branch: 'feature' } });
  await S.createChatThread('x');
  assert.equal(callsOf('git.worktreeAdd')[0][1].branch, 'feature');
  assert.equal(callsOf('git.worktreeAdd')[0][1].checkout, undefined);
  set({ newChatBranch: { ...pick(), path: '/w/other' } });
  await S.createChatThread('x');
  assert.deepEqual(callsOf('git.fetchPullRequest'), []);
});

test('Claude Code and a basic harness start in the pull request’s worktree too', async () => {
  S.setNewChatWorktree(true);
  set({
    newChatBranch: pick(),
    prefs: { ...st().prefs, defaultHarness: 'claude' },
    claude: { status: { state: 'apikey' } as any, models: [] },
  });
  const id = await S.createChatThread('x');
  assert.equal(callsOf('claude.startClaudeThread').at(-1)![0].cwd, '/wt/fix-thing');
  assert.equal(st().worktreeOf[id!], '/w/p');
  set({
    newChatBranch: pick(),
    basicHarnesses: [{ id: 'kimi', state: 'admitted' }] as any,
    prefs: { ...st().prefs, defaultHarness: 'acp:kimi' },
  });
  impl['acp.startAcpThread'] = (o: any) => `acp:${o.harness}:${o.cwd}`;
  assert.equal(await S.createChatThread('x'), 'acp:kimi:/wt/fix-thing');
  assert.equal(callsOf('git.fetchPullRequest').length, 2);
});
