// Repository drafts cannot start in a different checkout when their chosen execution location is retired.
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { deferred } from './support/async-scenarios.ts';
import { machineFolderKey } from '../src/lib/machineFolder.ts';
import { loadStore, callsOf, impl, resetAll, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const { selectRepositoryDestination, clearCloudDestination, repositoryDraftProblem, verifyRepositoryMachine } = await import(
  '../src/store/repositoryDraft.ts'
);
const { selectLocalProject } = await import('../src/store/localProjectDraft.ts');
const { dropGoneHostPick } = await import('../src/store/projects.ts');
const state = S.useStore.getState;
const set = S.useStore.setState;

const machine = { kind: 'machine', id: 'box', name: 'Build box', path: '/checkout', scope: 'old-scope' } as const;
const cloud = { kind: 'cloud', id: 'env', label: 'Cloud app' } as const;
const local = { kind: 'local', path: '/local/checkout', projectId: 'original' } as const;
const draft = {
  key: 'original',
  name: 'App',
  repository: 'github.com/org/app',
  needsLocation: false,
  destinations: [local, machine, cloud],
};

beforeEach(() => {
  resetState();
  resetAll();
  set({ conn: 'ready', route: { name: 'home' }, home: '/home/me' });
});

test('picking a different project retires a repository Cloud destination', () => {
  selectRepositoryDestination(draft, cloud);
  selectLocalProject('other');
  assert.equal(state().newChatRepositoryGroup, undefined);
  assert.equal(state().newChatCloudEnv, null);
  assert.equal(state().newChatProjectId, 'other');
});

test('a removed machine leaves a draft asking for an explicit new location, also for voice', async () => {
  selectRepositoryDestination(draft, machine);
  dropGoneHostPick([machine.id]);
  assert.deepEqual(state().newChatRepositoryGroup?.destinations, [local, cloud]);
  assert.equal(state().newChatRepositoryGroup?.needsLocation, true);
  assert.equal(state().newChatHost, null);
  assert.equal(await S.createChatThread('Typed text'), null);
  assert.equal(await S.createChatThread('Voice chat', { typed: false }), null);
  assert.deepEqual(
    state().toasts.map((toast) => toast.text),
    ['Choose where to run this chat.', 'Choose where to run this chat.'],
  );
  assert.equal(callsOf('acp.startHostAcpThread').length, 0);
  assert.equal(callsOf('fs.mkdirProjectless').length, 0);
});

test('voice cannot fall back to a local chat from a repository Cloud destination', async () => {
  selectRepositoryDestination(draft, cloud);
  assert.equal(await S.createChatThread('Voice chat', { typed: false }), null);
  assert.equal(state().newChatCloudEnv?.id, 'env');
  assert.equal(callsOf('fs.mkdirProjectless').length, 0);
});

test('a machine whose checkout changed is asked for its repository before a start', async () => {
  selectRepositoryDestination(draft, machine);
  impl['host.sidebarRepository'] = async () => ({ value: 'github.com/org/replacement' });
  assert.equal(await S.createChatThread('Typed text'), null);
  assert.deepEqual(callsOf('host.sidebarRepository'), [[machine.id, { path: machine.path, fresh: true, expectedHostKey: machine.scope }]]);
  assert.equal(callsOf('acp.startHostAcpThread').length, 0);
});

test('removing the selected local project does not send into another saved checkout', async () => {
  selectRepositoryDestination(draft, local);
  set({ savedProjects: [{ id: 'other', name: 'Other', roots: [{ path: '/another' }] }] });
  assert.equal(await S.createChatThread('Voice chat', { typed: false }), null);
  assert.equal(await S.createChatThread('Typed text'), null);
  assert.equal(callsOf('api.threadStart').length, 0);
});

test('a Cloud-only draft still needs a location after Undo or a reload', async () => {
  const cloudOnly = { ...draft, destinations: [cloud] };
  selectRepositoryDestination(cloudOnly, cloud);
  clearCloudDestination();
  assert.equal(state().newChatCloudEnv, null);
  assert.equal(state().newChatRepositoryGroup?.needsLocation, true);

  bootImpls({ 'state.read': async () => ({ newChatRepositoryGroup: cloudOnly, newChatCloudEnv: cloud }) });
  await S.boot();
  assert.equal(state().newChatCloudEnv, null);
  assert.deepEqual(state().newChatRepositoryGroup, { ...cloudOnly, needsLocation: true });
  assert.equal(await S.createChatThread('Typed text'), null);
});

test('a draft changed during its remote branch lookup never switches branches or starts a chat', async () => {
  selectRepositoryDestination(draft, machine);
  set({ newChatWorktree: true });
  impl['host.sidebarRepository'] = async () => ({ value: draft.repository });
  const reading = deferred<void>();
  const branchReply = deferred<unknown>();
  impl['host.gitBranches'] = () => {
    reading.resolve();
    return branchReply.promise;
  };
  const start = S.createChatThread('Voice chat', { typed: false });
  await reading.promise;
  selectLocalProject('other');
  branchReply.resolve({ value: { isRepo: true, current: 'main', branches: ['main'], commits: true, top: machine.path, sub: '' } });
  assert.equal(await start, null);
  assert.deepEqual(callsOf('host.gitBranches'), [[machine.id, { path: machine.path, expectedHostKey: machine.scope }]]);
  assert.equal(callsOf('host.worktree').length, 0);
  assert.equal(callsOf('acp.startHostAcpThread').length, 0);
});

test('scope follows a verified machine through branch selection and the resulting start', async () => {
  selectRepositoryDestination(draft, machine);
  set({ newChatBranch: { path: machineFolderKey(machine.id, machine.path), branch: 'feature' }, newChatWorktree: false });
  impl['host.sidebarRepository'] = async () => ({ value: draft.repository });
  impl['host.gitBranches'] = async () => ({
    value: { isRepo: true, current: 'main', branches: ['main', 'feature'], commits: true, top: machine.path, sub: '' },
  });
  impl['host.gitSwitch'] = async () => ({ value: { ok: true } });
  impl['acp.startHostAcpThread'] = async () => 'acp:codex:verified';
  assert.equal(await S.createChatThread('A branch on the selected machine'), 'acp:codex:verified');
  assert.deepEqual(callsOf('host.gitSwitch'), [[machine.id, { path: machine.path, branch: 'feature', expectedHostKey: machine.scope }]]);
  assert.equal(callsOf('acp.startHostAcpThread')[0][0].host.scope, machine.scope);
});

test('leaving a repository draft clears its Cloud environment and keeps a new standalone draft local', () => {
  selectRepositoryDestination(draft, cloud);
  S.clearNewChatProject();
  assert.equal(state().newChatCloudEnv, null);
  assert.equal(state().newChatRepositoryGroup, undefined);
  assert.equal(state().newChatProjectId, 'none');
});

test('the repository draft reopens its chooser after persisted Cloud execution is retired', async () => {
  bootImpls();
  await S.boot();
  selectRepositoryDestination(draft, cloud);
  mock.timers.tick(300);
  const lastWrite = callsOf('state.write').at(-1)?.[0];
  assert.equal(lastWrite?.newChatCloudEnv, null);
  assert.equal(lastWrite?.newChatRepositoryGroup.repository, draft.repository);
});

test('a local repository draft uses the selected root or explicit folder and refuses stale target metadata', () => {
  selectRepositoryDestination(draft, local);
  set({ savedProjects: [{ id: 'original', name: 'Original', roots: [{ path: local.path }] }] });
  assert.equal(repositoryDraftProblem(state(), null), null);
  set({ savedProjects: [{ id: 'original', name: 'Original', roots: [] }] });
  assert.match(repositoryDraftProblem(state(), null) ?? '', /choose where/i);

  const folder = { ...local, projectId: null };
  selectRepositoryDestination({ ...draft, destinations: [folder] }, folder);
  assert.equal(repositoryDraftProblem(state(), null), null);
  set({ newChatProjectId: 'other' });
  assert.match(repositoryDraftProblem(state(), null) ?? '', /choose where/i);
});

test('a repository draft refuses a Host location it never offered and rechecks a legacy unscoped pick', async () => {
  assert.equal(await verifyRepositoryMachine(draft, { id: 'unknown', path: machine.path }), null);
  const legacy = { ...machine, scope: undefined };
  selectRepositoryDestination({ ...draft, destinations: [legacy] }, legacy);
  const picked = state().newChatRepositoryGroup!;
  impl['host.sidebarRepository'] = async () => ({ value: draft.repository });
  assert.deepEqual(await verifyRepositoryMachine(picked, legacy), { scope: '' });
  assert.deepEqual(callsOf('host.sidebarRepository'), [[machine.id, { path: machine.path, fresh: true, expectedHostKey: '' }]]);
});

test('retargeting after a scoped worktree request started prevents the prepared chat from starting', async () => {
  selectRepositoryDestination(draft, machine);
  set({ newChatWorktree: true });
  impl['host.sidebarRepository'] = async () => ({ value: draft.repository });
  impl['host.gitBranches'] = async () => ({
    value: { isRepo: true, current: 'main', default: 'main', branches: ['main'], commits: true, top: machine.path, sub: '' },
  });
  const preparation = deferred<void>();
  const worktree = deferred<unknown>();
  impl['host.worktree'] = () => {
    preparation.resolve();
    return worktree.promise;
  };
  const start = S.createChatThread('Try a worktree');
  await preparation.promise;
  selectLocalProject('other');
  worktree.resolve({ value: { path: '/srv/prepared' } });
  assert.equal(await start, null);
  assert.equal(callsOf('host.worktree')[0][1].expectedHostKey, 'old-scope');
  assert.equal(callsOf('acp.startHostAcpThread').length, 0);
});
