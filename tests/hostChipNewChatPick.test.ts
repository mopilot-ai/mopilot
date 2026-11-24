// A machine picked for the next new chat in the composer's host chip (store/projects.ts pickNewChatHost, setNewChatHostFolder; store/send.ts createChatThread): the pick is what the send starts on, This Mac drops it, the folder last used on a machine comes back with it, and a machine with no folder yet is refused with the draft kept.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, bootImpls, resetAll, impl, listeners } from './support/store-harness.ts';

const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const { dropGoneHostPick, forgetHostMachine, newChatHostPick, newChatTarget, pickNewChatHost, setNewChatHostFolder } = await import(
  '../src/store/projects.ts'
);
const { loadPrefs } = await import('../src/store/types.ts');
const MINI = { id: 'ssh:me@mini', name: 'mac-mini-test' };
/** The device and folder, without the draft's history. */
const plain = (p: Record<string, unknown> | null | undefined) => {
  const { before: _before, remembered: _remembered, ...rest } = p ?? {};
  return rest;
};

beforeEach(() => {
  resetState();
  resetAll();
  set({ conn: 'ready', home: '/home/me', route: { name: 'home' } });
});

test('a new chat selected from a project carries that Host registration through to start', async () => {
  const host = { ...MINI, scope: 'original' };
  setNewChatHostFolder(host, '/srv/app');
  assert.equal(newChatHostPick()?.scope, host.scope);
  set({ newChatHost: { ...newChatHostPick()!, agent: 'kimi' } });
  setNewChatHostFolder(MINI, '/srv/app/src');
  assert.equal(newChatHostPick()?.scope, host.scope);
  assert.equal(newChatHostPick()?.agent, 'kimi');
  impl['acp.startHostAcpThread'] = async () => 'acp:host-codex:scoped-project';
  set({ newChatWorktree: true });
  impl['host.gitBranches'] = async () => ({ error: { code: 'machine_changed', message: 'This machine changed.' } });
  assert.equal(await S.createChatThread('Hello'), null);
  assert.deepEqual(callsOf('host.gitBranches'), [[host.id, { path: '/srv/app/src', expectedHostKey: host.scope }]]);
  assert.equal(callsOf('acp.startHostAcpThread').length, 0);
  set({ newChatWorktree: false });
  await S.createChatThread('Hello');
  assert.equal(callsOf('acp.startHostAcpThread')[0][0].host.scope, host.scope);
});

test('a new pairing for the same Host id replaces the previous registration and its agent', () => {
  set({ newChatHost: { ...MINI, path: '/srv/app', agent: 'kimi' } });
  const host = { ...MINI, scope: 'first' };
  setNewChatHostFolder(host, '/srv/app/src');
  assert.equal(newChatHostPick()?.agent, 'kimi');
  setNewChatHostFolder(host, '/srv/app');
  assert.equal(newChatHostPick()?.agent, 'kimi');
  setNewChatHostFolder({ ...host, scope: 'second' }, '/work/repo');
  assert.deepEqual(plain(newChatHostPick()), { ...MINI, scope: 'second', path: '/work/repo' });
});

test('picking a machine makes it the new chat target with no folder yet; This Mac drops the pick', () => {
  set({ newChatProjectId: 'p1', newChatCwd: null });
  assert.deepEqual(plain(pickNewChatHost(MINI)), { ...MINI, path: '' });
  assert.deepEqual(plain(newChatHostPick()), { ...MINI, path: '' }, 'the pick replaces the project picked before it');
  assert.deepEqual(newChatTarget(), { name: 'mac-mini-test', path: '', projectId: null }, 'no folder: the target is the machine');
  assert.equal(pickNewChatHost({ id: 'local', name: 'This Mac' }), null);
  assert.equal(st().newChatHost, null);
  assert.equal(newChatHostPick(), null);
  // This Mac with nothing picked changes nothing
  set({ newChatProjectId: 'p1' });
  assert.equal(pickNewChatHost({ id: 'local', name: 'This Mac' }), null);
  assert.equal(st().newChatProjectId, 'p1');
});

test('the same machine again keeps its folder and agent; another machine starts in the folder last used there', () => {
  set({ newChatProjectId: null, newChatCwd: null, newChatHost: { ...MINI, path: '/srv/app', agent: 'kimi' } });
  assert.deepEqual(plain(pickNewChatHost(MINI)), { ...MINI, path: '/srv/app', agent: 'kimi' });
  set({ prefs: { ...st().prefs, hostFolders: { 'ssh:me@box': '/home/u/repo' } } });
  assert.deepEqual(plain(pickNewChatHost({ id: 'ssh:me@box', name: 'box' })), { id: 'ssh:me@box', name: 'box', path: '/home/u/repo' });
  assert.deepEqual(newChatTarget()?.name, 'repo · box');
});

test('a folder picked from the chip keeps the agent picked on the same machine, and not one picked on another', () => {
  set({ newChatProjectId: null, newChatCwd: null, newChatHost: { ...MINI, path: '', agent: 'kimi' } });
  setNewChatHostFolder(MINI, '/srv/app');
  assert.deepEqual(plain(newChatHostPick()), { ...MINI, path: '/srv/app', agent: 'kimi' });
  setNewChatHostFolder({ id: 'ssh:me@box', name: 'box' }, '/w');
  assert.deepEqual(plain(newChatHostPick()), { id: 'ssh:me@box', name: 'box', path: '/w' });
  // a project picked meanwhile is replaced: the folder is the newest pick
  set({ newChatProjectId: 'p1' });
  setNewChatHostFolder(MINI, '/srv/app');
  assert.deepEqual(plain(newChatHostPick()), { ...MINI, path: '/srv/app' });
});

test('a send on a machine with no folder yet is refused with why, nothing started; one with a folder starts there and remembers it', async () => {
  set({ basicHarnesses: [{ id: 'kimi', state: 'admitted' }] as any, prefs: { ...st().prefs, defaultHarness: 'acp:kimi' } });
  pickNewChatHost(MINI);
  assert.equal(await S.createChatThread('hello'), null);
  assert.equal(callsOf('acp.startHostAcpThread').length, 0);
  assert.equal(st().toasts.at(-1)?.text, 'Pick a folder on mac-mini-test.');
  setNewChatHostFolder(MINI, '/srv/app');
  impl['acp.startHostAcpThread'] = async (o: any) => `acp:${o.harness}:1`;
  assert.equal(await S.createChatThread('hello'), 'acp:kimi:1');
  assert.deepEqual(callsOf('acp.startHostAcpThread'), [
    [{ host: { ...MINI, path: '/srv/app', before: { projectId: null, cwd: null } }, harness: 'kimi' }],
  ]);
  assert.deepEqual(st().prefs.hostFolders, { [MINI.id]: '/srv/app' });
  // the next pick of that machine, after This Mac, starts in that folder again (also while the machine is away)
  pickNewChatHost({ id: 'local', name: 'This Mac' });
  assert.deepEqual(plain(pickNewChatHost(MINI)), { ...MINI, path: '/srv/app' });
});

test('a machine that refuses the start leaves no remembered folder', async () => {
  set({ basicHarnesses: [{ id: 'kimi', state: 'admitted' }] as any, prefs: { ...st().prefs, defaultHarness: 'acp:kimi' } });
  setNewChatHostFolder(MINI, '/srv/app');
  impl['acp.startHostAcpThread'] = async () => {
    throw new Error('Kimi Code is not installed on mac-mini-test.');
  };
  assert.equal(await S.createChatThread('hello'), null);
  assert.deepEqual(st().prefs.hostFolders, {});
});

test('This Mac goes back to the target the machine pick replaced: no project, a project or a local folder', () => {
  const local = { id: 'local', name: 'This Mac' };
  for (const [projectId, cwd] of [
    ['none', null],
    ['p1', null],
    [null, '/local'],
  ] as const) {
    set({ newChatProjectId: projectId, newChatCwd: cwd, newChatHost: null });
    pickNewChatHost(MINI);
    // another machine, a folder picked on it, the same machine again: the target from before the first pick stays
    pickNewChatHost({ id: 'ssh:me@box', name: 'box' });
    setNewChatHostFolder({ id: 'ssh:me@box', name: 'box' }, '/w');
    pickNewChatHost({ id: 'ssh:me@box', name: 'box' });
    pickNewChatHost(local);
    assert.deepEqual([st().newChatProjectId, st().newChatCwd, st().newChatHost], [projectId, cwd, null], String(projectId ?? cwd));
  }
  // a folder picked from the project menu with nothing picked before keeps that target too
  set({ newChatProjectId: 'none', newChatCwd: null, newChatHost: null });
  setNewChatHostFolder(MINI, '/srv/app');
  pickNewChatHost(local);
  assert.equal(st().newChatProjectId, 'none');
  // a pick that carries no earlier target (one set before this was kept) goes back to the default
  set({ newChatProjectId: null, newChatCwd: null, newChatHost: { ...MINI, path: '/srv/app' } });
  pickNewChatHost(local);
  assert.deepEqual([st().newChatProjectId, st().newChatCwd], [null, null]);
});

test("a removed machine's folder is forgotten, and a new chat picked on it goes back to the target from before", () => {
  set({ prefs: { ...st().prefs, hostFolders: { [MINI.id]: '/srv/app', 'ssh:me@box': '/w' } }, newChatProjectId: 'none', newChatCwd: null });
  pickNewChatHost(MINI);
  forgetHostMachine(MINI.id);
  assert.deepEqual(st().prefs.hostFolders, { 'ssh:me@box': '/w' });
  assert.equal(newChatHostPick(), null);
  assert.equal(st().newChatProjectId, 'none');
  // added again under the same id: no folder comes back
  assert.deepEqual(pickNewChatHost(MINI)?.path, '');
  // a machine with no folder and no pick: nothing is written
  const prefs = st().prefs;
  forgetHostMachine('ssh:me@gone');
  assert.equal(st().prefs, prefs);
  assert.deepEqual(newChatHostPick()?.id, MINI.id, "another machine's removal keeps this pick");
});

test("a new chat's pick of a machine that was listed and is gone goes, and any other stays", () => {
  set({ newChatProjectId: 'none', newChatCwd: null });
  pickNewChatHost(MINI);
  dropGoneHostPick(['ssh:me@box']);
  assert.equal(newChatHostPick()?.id, MINI.id);
  dropGoneHostPick([MINI.id]);
  assert.equal(newChatHostPick(), null);
  assert.equal(st().newChatProjectId, 'none', 'the target from before comes back');
  dropGoneHostPick([MINI.id]);
  assert.equal(newChatHostPick(), null, 'no pick: nothing to drop');
});

test('a machine picked anywhere (Run on, the sidebar, a folder) drops a Codex Cloud environment: the chat runs where it shows', () => {
  const env = { id: 'e1', label: 'web-app' };
  set({ newChatCloudEnv: env });
  pickNewChatHost(MINI);
  assert.equal(st().newChatCloudEnv, null);
  set({ newChatCloudEnv: env });
  pickNewChatHost(MINI);
  assert.equal(st().newChatCloudEnv, null, 'the same machine again too');
  pickNewChatHost(MINI);
  assert.equal(st().newChatCloudEnv, null, 'nothing to drop: still none');
  set({ newChatCloudEnv: env });
  setNewChatHostFolder(MINI, '/srv/app');
  assert.equal(st().newChatCloudEnv, null);
  // This Mac is left to its caller: a cloud environment is picked through it (RunOnChip)
  set({ newChatCloudEnv: env });
  pickNewChatHost({ id: 'local', name: 'This Mac' });
  assert.deepEqual(st().newChatCloudEnv, env);
});

test('regular New chat remembers Run on across a local project, and an explicit This Mac clears it', () => {
  pickNewChatHost(MINI);
  setNewChatHostFolder(MINI, '/srv/app');
  set({ newChatProjectId: 'local-project', newChatTemporary: true, newChatCloudEnv: { id: 'cloud', label: 'Cloud' } });
  assert.equal(newChatHostPick(), null);
  S.clearNewChatProject(true);
  assert.deepEqual(plain(newChatHostPick()), { ...MINI, path: '/srv/app' });
  assert.equal(st().newChatTemporary, false);
  assert.equal(st().newChatCloudEnv, null);

  S.clearNewChatProject();
  assert.equal(newChatHostPick(), null, 'an explicitly projectless local entry point stays local');
  pickNewChatHost({ id: 'local', name: 'This Mac' });
  S.clearNewChatProject(true);
  assert.equal(newChatHostPick(), null);
  assert.equal(st().prefs.lastNewChatHost, null);
});

test('a remembered device sends to that machine across Codex, Claude Code and ACP', async () => {
  pickNewChatHost(MINI);
  setNewChatHostFolder(MINI, '/srv/app');
  impl['acp.startHostAcpThread'] = async ({ harness }: { harness: string }) => `host-${harness}`;
  for (const [kind, id] of [
    ['codex', 'codex'],
    ['claude', 'claude'],
    ['acp:kimi', 'kimi'],
  ] as const) {
    set({ prefs: { ...st().prefs, defaultHarness: kind } });
    S.clearNewChatProject(true);
    assert.equal(await S.createChatThread('hello'), `host-${id}`);
  }
  assert.deepEqual(
    callsOf('acp.startHostAcpThread').map(([request]) => [request.host.id, request.host.path, request.harness]),
    [
      [MINI.id, '/srv/app', 'codex'],
      [MINI.id, '/srv/app', 'claude'],
      [MINI.id, '/srv/app', 'kimi'],
    ],
  );
  assert.equal(callsOf('codex.startThread').length + callsOf('claude.startClaudeThread').length + callsOf('acp.startAcpThread').length, 0);
});

test('boot restores the saved Run on choice and folder for a regular draft, preserving explicit local targets', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let savedPrefs = {};
  let draft: { newChatCwd?: string; newChatProjectId?: string; newChatCloudEnv?: { id: string; label: string } } = {};
  bootImpls({
    'state.read': async () => ({ ...draft, prefs: savedPrefs }),
    'prefs.patch': async (patch: object) => {
      savedPrefs = { ...savedPrefs, ...patch };
    },
  });
  await S.boot();
  assert.equal(newChatHostPick(), null);
  pickNewChatHost(MINI);
  S.setPrefs({ hostFolders: { [MINI.id]: '/srv/app' } });
  assert.deepEqual(callsOf('prefs.patch').at(-2), [{ lastNewChatHost: MINI }, []]);

  set({ newChatHost: null });
  draft = { newChatProjectId: 'none' };
  await S.boot();
  assert.deepEqual(plain(newChatHostPick()), { ...MINI, path: '/srv/app' });
  assert.equal(st().newChatCloudEnv, null);

  const cloud = { id: 'cloud', label: 'Cloud' };
  draft = { newChatProjectId: 'none', newChatCloudEnv: cloud };
  await S.boot();
  assert.equal(newChatHostPick(), null);
  assert.deepEqual(st().newChatCloudEnv, cloud);

  for (draft of [{ newChatProjectId: 'project' }, { newChatCwd: '/local' }]) {
    await S.boot();
    assert.equal(newChatHostPick(), null);
    assert.deepEqual(st().prefs.lastNewChatHost, MINI);
  }
  draft = {};
  await S.boot({ quickChat: true });
  assert.equal(newChatHostPick(), null);
  assert.deepEqual(st().prefs.lastNewChatHost, MINI);
});

test('a device removed after the startup snapshot is never restored by the opening window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  bootImpls({
    'state.read': async () => ({ prefs: { lastNewChatHost: MINI } }),
    'speech.drafts': async () => {
      listeners['prefs.onChanged']({ set: { lastNewChatHost: null }, unset: [] });
      return {};
    },
  });
  await S.boot();
  assert.equal(newChatHostPick(), null);
  assert.equal(st().prefs.lastNewChatHost, null);
});

test('a committed removal retires an active draft without needing a resolved machine list', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const other = { id: 'ssh:me@other', name: 'Other' };
  bootImpls({ 'state.read': async () => ({ prefs: { lastNewChatHost: MINI } }) });
  await S.boot();
  assert.equal(newChatHostPick()?.id, MINI.id);
  listeners['prefs.onChanged']({ set: { lastNewChatHost: other }, unset: [] });
  listeners['host.onMachineRemoved']('unrelated');
  assert.equal(newChatHostPick()?.id, MINI.id);
  listeners['host.onMachineRemoved'](MINI.id);
  assert.equal(newChatHostPick(), null);
  assert.deepEqual(st().prefs.lastNewChatHost, other);
});

test('a failed startup read releases the preference listener', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let stops = 0;
  for (const read of ['state.read', 'chats.snapshot', 'app.info']) {
    bootImpls({
      'prefs.onChanged': () => () => {
        stops++;
      },
      [read]: async () => {
        throw new Error('unreadable');
      },
    });
    await assert.rejects(S.boot(), /unreadable/);
  }
  assert.equal(stops, 3);
});

test('unknown or malformed saved choices default to this computer', () => {
  for (const lastNewChatHost of [
    null,
    [],
    'host',
    {},
    { id: 13, name: 'box' },
    { ...MINI, id: '' },
    { ...MINI, id: 'local' },
    { id: MINI.id },
  ]) {
    assert.equal(loadPrefs({ lastNewChatHost }).lastNewChatHost, null);
  }
});

test('restoring a device with no valid remembered folder still lets the user choose one', () => {
  for (const hostFolders of [undefined, null, { [MINI.id]: 23 }]) {
    set({ prefs: loadPrefs({ lastNewChatHost: MINI, hostFolders }) });
    S.clearNewChatProject(true);
    assert.deepEqual(plain(newChatHostPick()), { ...MINI, path: '' });
  }
});
