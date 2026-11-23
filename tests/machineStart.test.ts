// A new chat on a machine starts where the draft's Worktree switch and branch pick say (src/store/machineStart.ts, src/store/chatCreation.ts createHostChatThread): in a worktree the machine makes on a new branch, on the picked branch of its folder, or in the folder as it is; each through the machine's Host, never this Mac's git.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, resetAll, impl } from './support/store-harness.ts';

const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const { newChatFolderKey } = await import('../src/store/projects.ts');
const PICK = { id: 'box', name: 'build-box', path: '/srv/app' };
const KEY = 'box\0/srv/app';
const LIST = {
  isRepo: true,
  current: 'feature',
  default: 'main',
  branches: ['main', 'feature', 'dev'],
  commits: true,
  top: '/srv/app',
  sub: '',
};
const texts = () => st().toasts.map((t) => t.text);
const lastStart = () => callsOf('acp.startHostAcpThread').at(-1)![0] as { host: { id: string; path: string } };
const reply = (value: unknown) => ({ value });
const refusal = (code: string, message = 'No.') => ({ error: { code, message } });

beforeEach(() => {
  resetState();
  resetAll();
  set({
    conn: 'ready',
    home: '/home/me',
    route: { name: 'home' },
    newChatProjectId: null,
    newChatCwd: null,
    newChatHost: PICK,
    basicHarnesses: [{ id: 'kimi', state: 'admitted' }] as any,
    prefs: { ...st().prefs, defaultHarness: 'acp:kimi', worktreeDefault: false },
  });
  impl['acp.startHostAcpThread'] = async (o: any) => `acp:${o.harness}:1`;
  impl['host.gitBranches'] = async () => reply(LIST);
  impl['host.worktree'] = async (_id: string, q: any) =>
    reply({ path: `/srv/app.worktrees/${q.branch.replace('/', '%2f')}`, existed: false });
  impl['host.gitSwitch'] = async () => reply({ ok: true, stderr: '' });
});

test("the draft's folder key is the machine's folder, or none until one is picked; a folder of this Mac is its own path", () => {
  assert.equal(newChatFolderKey(), KEY);
  assert.equal(newChatFolderKey(st()), KEY);
  set({ newChatHost: { ...PICK, path: '' } });
  assert.equal(newChatFolderKey(), null);
  set({ newChatHost: null, newChatCwd: '/local/app' });
  assert.equal(newChatFolderKey(), '/local/app');
  set({ newChatCwd: null, newChatProjectId: 'none' });
  assert.equal(newChatFolderKey(), null);
});

test('no Worktree switch and no pick: the chat starts in the folder and the machine is asked nothing', async () => {
  assert.equal(await S.createChatThread('hello'), 'acp:kimi:1');
  assert.equal(lastStart().host.path, '/srv/app');
  for (const call of ['host.gitBranches', 'host.worktree', 'host.gitSwitch', 'git.worktreeAdd', 'git.switchBranch', 'git.branches'])
    assert.equal(callsOf(call).length, 0, call);
});

test("the Worktree switch makes a worktree on a new branch from origin's default, and the chat runs there; the draft's own choice ends with it", async () => {
  set({ newChatWorktree: true, prefs: { ...st().prefs, defaultHarness: 'acp:kimi', branchPrefix: 'wt/' } });
  assert.equal(await S.createChatThread('hello'), 'acp:kimi:1');
  const [id, q] = callsOf('host.worktree')[0] as [string, any];
  assert.equal(id, 'box');
  assert.match(q.branch, /^wt\/[0-9a-f]{8}$/);
  assert.match(q.key, /^app:/);
  assert.deepEqual({ repo: q.repo, from: q.from }, { repo: '/srv/app', from: 'main' });
  assert.equal(lastStart().host.path, `/srv/app.worktrees/${q.branch.replace('/', '%2f')}`);
  assert.equal(lastStart().host.id, 'box');
  assert.ok(texts().includes(`Working in worktree on ${q.branch}`));
  assert.equal(st().newChatWorktree, null);
  // none of this ran on this Mac
  for (const local of ['git.worktreeAdd', 'git.switchBranch', 'git.branches']) assert.equal(callsOf(local).length, 0, local);
});

test('the saved default turns the switch on; the picked branch is the start, and a folder inside the repository keeps its place in the worktree', async () => {
  set({ prefs: { ...st().prefs, defaultHarness: 'acp:kimi', worktreeDefault: true }, newChatBranch: { path: KEY, branch: 'dev' } });
  impl['host.gitBranches'] = async () => reply({ ...LIST, sub: 'packages/web' });
  assert.equal(await S.createChatThread('hello'), 'acp:kimi:1');
  const q = (callsOf('host.worktree')[0] as [string, any])[1];
  assert.match(q.branch, /^mopilot\/[0-9a-f]{8}$/);
  assert.equal(q.from, 'dev');
  assert.equal(lastStart().host.path, `/srv/app.worktrees/${q.branch.replace('/', '%2f')}/packages/web`);
  // a pick made for another folder is not this draft's
  resetAll();
  impl['acp.startHostAcpThread'] = async (o: any) => `acp:${o.harness}:2`;
  impl['host.gitBranches'] = async () => reply({ ...LIST, default: null, current: 'feature' });
  impl['host.worktree'] = async (_id: string, q2: any) => reply({ path: `/wt/${q2.branch}`, existed: false });
  set({ newChatBranch: { path: 'box\0/other', branch: 'dev' } });
  await S.createChatThread('again');
  assert.equal((callsOf('host.worktree')[0] as [string, any])[1].from, 'feature', 'no default: the checked-out branch');
  impl['host.gitBranches'] = async () => reply({ ...LIST, default: null, current: null });
  await S.createChatThread('detached');
  assert.equal('from' in (callsOf('host.worktree')[1] as [string, any])[1], false, "nothing to start from: the Host's HEAD");
});

test("with no branch prefix saved, the worktree's branch is named as on this Mac, and a draft changed while the chat starts keeps its new choice", async () => {
  set({ newChatWorktree: true, prefs: { ...st().prefs, defaultHarness: 'acp:kimi', branchPrefix: '' } });
  impl['acp.startHostAcpThread'] = async (o: any) => {
    // the person turned Worktree off again while the chat was starting: that is the next draft's choice
    set({ newChatWorktree: false });
    return `acp:${o.harness}:1`;
  };
  assert.equal(await S.createChatThread('hello'), 'acp:kimi:1');
  assert.match((callsOf('host.worktree')[0] as [string, any])[1].branch, /^mopilot\/[0-9a-f]{8}$/);
  assert.equal(st().newChatWorktree, false);
});

test('without the switch, a picked branch is checked out in the folder on the machine, unless it is the one there', async () => {
  set({ newChatBranch: { path: KEY, branch: 'dev' } });
  assert.equal(await S.createChatThread('hello'), 'acp:kimi:1');
  assert.deepEqual(callsOf('host.gitSwitch'), [['box', { path: '/srv/app', branch: 'dev' }]]);
  assert.equal(lastStart().host.path, '/srv/app');
  assert.equal(callsOf('host.worktree').length, 0);
  set({ newChatBranch: { path: KEY, branch: 'feature' } });
  await S.createChatThread('same');
  assert.equal(callsOf('host.gitSwitch').length, 1, 'already on it: nothing to switch');
});

test('a switch the machine refuses starts nothing and says why; so does a worktree it refuses', async () => {
  set({ newChatBranch: { path: KEY, branch: 'dev' } });
  impl['host.gitSwitch'] = async () =>
    reply({ ok: false, refused: true, stderr: 'Can\'t switch to "dev": there are uncommitted changes.' });
  assert.equal(await S.createChatThread('hello'), null);
  assert.ok(texts().includes('Failed to start chat: Can\'t switch to "dev": there are uncommitted changes.'));
  impl['host.gitSwitch'] = async () => reply({ ok: false, stderr: 'fatal: boom\nmore' });
  assert.equal(await S.createChatThread('hello'), null);
  assert.ok(texts().includes('Failed to start chat: fatal: boom'));
  impl['host.gitSwitch'] = async () => reply({ ok: false, stderr: '' });
  assert.equal(await S.createChatThread('hello'), null);
  assert.ok(texts().includes('Failed to start chat: Failed to switch to "dev"'));
  impl['host.gitSwitch'] = async () => refusal('write_timed_out', 'slow');
  assert.equal(await S.createChatThread('hello'), null);
  set({ newChatBranch: null, newChatWorktree: true });
  impl['host.worktree'] = async () => refusal('outside_roots', 'x');
  assert.equal(await S.createChatThread('hello'), null);
  assert.ok(texts().includes('Failed to start chat: That folder is outside what this machine shares.'));
  assert.equal(callsOf('acp.startHostAcpThread').length, 0);
  assert.equal(st().newChatWorktree, true, 'the draft keeps its choice');
});

test('a folder that is no repository, or has no commit, runs the chat as it is', async () => {
  set({ newChatWorktree: true });
  impl['host.gitBranches'] = async () => reply({ isRepo: false });
  assert.equal(await S.createChatThread('hello'), 'acp:kimi:1');
  impl['host.gitBranches'] = async () => reply({ ...LIST, commits: false });
  assert.equal(await S.createChatThread('hello'), 'acp:kimi:1');
  assert.equal(callsOf('host.worktree').length, 0);
  assert.equal(callsOf('host.gitSwitch').length, 0);
  assert.equal(lastStart().host.path, '/srv/app');
  // a pick in a folder without commits is switched to all the same, as on this Mac (the Host says if it can't)
  set({ newChatBranch: { path: KEY, branch: 'dev' } });
  await S.createChatThread('picked');
  assert.equal(callsOf('host.gitSwitch').length, 1);
});

test('a Host from before the branch calls starts the chat in the folder and says to update it; any other refusal stops the chat', async () => {
  set({ newChatWorktree: true });
  impl['host.gitBranches'] = async () => refusal('host_outdated', 'Update it.');
  assert.equal(await S.createChatThread('hello'), 'acp:kimi:1');
  assert.ok(texts().includes('Update the Host on build-box to start a chat in a worktree.'));
  assert.equal(lastStart().host.path, '/srv/app');
  impl['host.gitBranches'] = async () => refusal('unknown_machine', 'x');
  set({ newChatWorktree: true });
  assert.equal(await S.createChatThread('hello'), null);
  assert.ok(texts().includes('Failed to start chat: That machine is not in your list.'));
});
