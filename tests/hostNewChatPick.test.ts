// A folder picked on a remote machine for the next new chat (store/projects.ts newChatHostPick, store/send.ts createChatThread): it applies only while nothing else was picked after it (A2), and the send is refused with a notice, the draft kept and nothing started (B2).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, resetAll, impl } from './support/store-harness.ts';

const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const { newChatHostPick, newChatTarget } = await import('../src/store/projects.ts');
const { createHostChatThread } = await import('../src/store/chatCreation.ts');
const PICK = { id: 'box', name: 'build-box', path: '/home/u/app' };

beforeEach(() => {
  resetState();
  resetAll();
  set({ conn: 'ready', home: '/home/me', route: { name: 'home' } });
});

test('the pick applies until a project, a local folder or "no project" is chosen after it', () => {
  assert.equal(newChatHostPick(), null, 'nothing picked');
  set({ newChatProjectId: null, newChatCwd: null, newChatHost: PICK });
  assert.deepEqual(newChatHostPick(), PICK);
  assert.deepEqual(newChatHostPick(st()), PICK);
  set({ newChatProjectId: 'p1' });
  assert.equal(newChatHostPick(), null, 'a project replaces it');
  set({ newChatProjectId: null, newChatCwd: '/else' });
  assert.equal(newChatHostPick(), null, 'a local folder replaces it');
  set({ newChatProjectId: 'none', newChatCwd: null });
  assert.equal(newChatHostPick(), null, '"no project" replaces it');
});

test('a send with a pick starts the chat on its machine with the basic agent picked, none on this Mac, and opens it', async () => {
  set({
    basicHarnesses: [{ id: 'kimi', state: 'admitted' }] as any,
    prefs: { ...st().prefs, defaultHarness: 'acp:kimi' },
    newChatProjectId: null,
    newChatCwd: null,
    newChatHost: PICK,
  });
  impl['acp.startHostAcpThread'] = async (o: any) => `acp:${o.harness}:1`;
  assert.equal(await S.createChatThread('hello'), 'acp:kimi:1');
  assert.deepEqual(callsOf('acp.startHostAcpThread'), [[{ host: PICK, harness: 'kimi' }]]);
  for (const local of ['codex.startThread', 'claude.startClaudeThread', 'acp.startAcpThread'])
    assert.equal(callsOf(local).length, 0, local);
  assert.deepEqual(st().route, { name: 'thread', id: 'acp:kimi:1' });
  // the pick is still there for the next chat on that machine
  assert.deepEqual(newChatHostPick(), PICK);
});

test('a send with a pick on Claude Code or Codex starts the chat on its machine under that family, none on this Mac', async () => {
  set({ newChatProjectId: null, newChatCwd: null, newChatHost: PICK });
  impl['acp.startHostAcpThread'] = async (o: any) => `acp:host-${o.harness}:1`;
  for (const family of ['claude', 'codex']) {
    // the machine's last agent would win over the default (prefs.hostPicks): each default is tested on a machine with none
    set({ prefs: { ...st().prefs, defaultHarness: family, hostPicks: {} } });
    assert.equal(await S.createChatThread('hello'), `acp:host-${family}:1`);
  }
  assert.deepEqual(callsOf('acp.startHostAcpThread'), [[{ host: PICK, harness: 'claude' }], [{ host: PICK, harness: 'codex' }]]);
  for (const local of ['codex.startThread', 'claude.startClaudeThread', 'acp.startAcpThread'])
    assert.equal(callsOf(local).length, 0, local);
});

test('a machine whose readiness is unknown gets the agent asked for, whether or not this Mac has it: the machine accepts or refuses it', async () => {
  set({
    basicHarnesses: [] as any,
    prefs: { ...st().prefs, defaultHarness: 'acp:kimi' },
    newChatProjectId: null,
    newChatCwd: null,
    newChatHost: PICK,
  });
  impl['acp.startHostAcpThread'] = async (o: any) => `acp:host-${o.harness}:1`;
  assert.equal(await S.createChatThread('hello'), 'acp:host-kimi:1');
});

test('B2: a send with a pick for a temporary chat is refused with the draft kept, as is a machine that refuses', async () => {
  set({ basicHarnesses: [{ id: 'kimi', state: 'admitted' }] as any, newChatProjectId: null, newChatCwd: null, newChatHost: PICK });
  set({ prefs: { ...st().prefs, defaultHarness: 'acp:kimi' }, newChatTemporary: true });
  assert.equal(await S.createChatThread('hello'), null);
  assert.equal(callsOf('acp.startHostAcpThread').length, 0);
  // main refuses (the agent is not installed there)
  set({ newChatTemporary: false });
  impl['acp.startHostAcpThread'] = async () => {
    throw new Error("kimi isn't installed on build-box.");
  };
  assert.equal(await S.createChatThread('hello'), null);
  assert.deepEqual(
    st().toasts.map((x: any) => x.text ?? x.message),
    ["Temporary chats can't run on build-box.", "Failed to start chat: kimi isn't installed on build-box."],
  );
  assert.deepEqual(newChatHostPick(), PICK);
  assert.notEqual(st().route.name, 'thread');
});

test('the target shows the folder with its machine and no path of this Mac, so nothing here looks inside it; a local pick shows as before', () => {
  set({ newChatProjectId: null, newChatCwd: null, newChatHost: PICK });
  assert.deepEqual(newChatTarget(), { name: 'app · build-box', path: '', projectId: null });
  set({ newChatCwd: '/else' });
  assert.deepEqual(newChatTarget(), { name: 'else', path: '/else', projectId: null });
});

const machineAgents = (...agents: [string, string, string?][]) => {
  impl['host.machines'] = async () => ({
    machines: [
      {
        ...PICK,
        status: 'online',
        note: '',
        signin: null,
        capabilities: {},
        agents: agents.map(([id, state, reason = '']) => ({ id, label: id, state, reason })),
      },
    ],
    resolved: true,
  });
};

test('a remote send uses the draft-local agent pick before the saved default, unless the machine has its own pick', async () => {
  set({ newChatProjectId: null, newChatCwd: null, newChatHost: PICK });
  impl['acp.startHostAcpThread'] = async (o: any) => `acp:host-${o.harness}:1`;
  for (const kind of ['codex', 'claude', 'acp:kimi'] as const) {
    set({ newChatHarnessPick: kind });
    const agent = kind === 'acp:kimi' ? 'kimi' : kind;
    assert.equal(await S.createChatThread('hello'), `acp:host-${agent}:1`);
  }
  set({ newChatHost: { ...PICK, agent: 'claude' }, newChatHarnessPick: 'acp:kimi' });
  assert.equal(await S.createChatThread('hello'), 'acp:host-claude:1');
});

test('a remote start retires its own draft pick, preserves a newer pick, and keeps a refused pick retryable', async () => {
  set({ newChatProjectId: null, newChatCwd: null, newChatHost: PICK, newChatHarnessPick: 'claude' });
  impl['acp.startHostAcpThread'] = async () => 'remote-1';
  assert.equal(await S.createChatThread('hello'), 'remote-1');
  assert.equal(st().newChatHarnessPick, null);

  for (const next of [null, 'codex', 'acp:kimi'] as const) {
    set({ newChatHarnessPick: 'claude' });
    impl['acp.startHostAcpThread'] = async () => {
      set({ newChatHarnessPick: next });
      return 'remote-2';
    };
    assert.equal(await S.createChatThread('hello'), 'remote-2');
    assert.equal(st().newChatHarnessPick, next);
  }

  set({ newChatHarnessPick: 'claude' });
  impl['acp.startHostAcpThread'] = async () => {
    throw new Error('offline');
  };
  assert.equal(await S.createChatThread('hello'), null);
  assert.equal(st().newChatHarnessPick, 'claude');
});

test('a completed remote start cannot retire a new draft that selected the same harness after a reset', async () => {
  set({ newChatProjectId: null, newChatCwd: null, newChatHost: PICK });
  S.pickNewChatHarness('claude');
  impl['acp.startHostAcpThread'] = async () => {
    S.resetNewChatDefaults();
    S.pickNewChatHarness('claude');
    return 'remote-1';
  };
  assert.equal(await S.createChatThread('hello'), 'remote-1');
  assert.equal(st().newChatHarnessPick, 'claude');
});

test('a Mac with no Claude login still starts the chat on a machine whose Claude Code is ready, whatever new chats fall back to here', async () => {
  set({
    claude: { ...st().claude, status: { state: 'signin' } as any },
    basicHarnesses: [{ id: 'kimi', state: 'admitted' }] as any,
    prefs: { ...st().prefs, defaultHarness: 'claude' },
    newChatProjectId: null,
    newChatCwd: null,
    newChatHost: PICK,
  });
  machineAgents(['claude', 'ready'], ['kimi', 'ready']);
  impl['acp.startHostAcpThread'] = async (o: any) => `acp:host-${o.harness}:1`;
  assert.equal(await S.createChatThread('hello'), 'acp:host-claude:1');
});

test('a Mac with Claude Code never starts the chat on it when the machine lacks it, and a pick made for the folder wins over the saved one', async () => {
  set({
    claude: { ...st().claude, status: { state: 'ready' } as any },
    prefs: { ...st().prefs, defaultHarness: 'claude' },
    newChatProjectId: null,
    newChatCwd: null,
    newChatHost: PICK,
  });
  impl['acp.startHostAcpThread'] = async (o: any) => `acp:host-${o.harness}:1`;
  machineAgents(['claude', 'signin', 'Sign in on build-box'], ['codex', 'ready']);
  assert.equal(await S.createChatThread('hello'), 'acp:host-codex:1');
  set({ newChatHost: { ...PICK, agent: 'codex' } });
  machineAgents(['claude', 'ready'], ['codex', 'ready']);
  assert.equal(await S.createChatThread('hello'), 'acp:host-codex:1');
  // nothing ready there: refused with the reason, nothing started
  const started = callsOf('acp.startHostAcpThread').length;
  machineAgents(['claude', 'signin', 'Sign in on build-box']);
  set({ newChatHost: PICK });
  assert.equal(await S.createChatThread('hello'), null);
  assert.equal(callsOf('acp.startHostAcpThread').length, started);
  assert.match(st().toasts.at(-1).text ?? st().toasts.at(-1).message, /Sign in on build-box. No agent is ready on build-box/);
});

test('a machine list that cannot be read keeps the saved pick and lets the machine refuse', async () => {
  set({ prefs: { ...st().prefs, defaultHarness: 'claude' }, newChatProjectId: null, newChatCwd: null, newChatHost: PICK });
  impl['host.machines'] = async () => {
    throw new Error('offline');
  };
  impl['acp.startHostAcpThread'] = async (o: any) => `acp:host-${o.harness}:1`;
  assert.equal(await S.createChatThread('hello'), 'acp:host-claude:1');
});

test('the new machine chat keeps only its matching draft model pick, captured before asynchronous startup', async () => {
  const selection = { hostId: 'box', harness: 'claude', model: 'remote-model', effort: 'high' };
  set({ newChatProjectId: null, newChatCwd: null, newChatHost: { ...PICK, agent: 'claude', selection } });
  machineAgents(['claude', 'ready']);
  impl['acp.startHostAcpThread'] = async () => {
    set({ newChatHost: { ...PICK, agent: 'codex' } });
    return 'acp:host-claude:chosen';
  };
  await S.createChatThread('model');
  assert.deepEqual(st().chatConfig['acp:host-claude:chosen'].hostSelection, selection);
  assert.equal(st().newChatHost?.agent, 'codex', 'a newer draft survives');
  for (const scope of [
    { hostId: 'other', harness: 'claude' },
    { hostId: 'box', harness: 'codex' },
  ]) {
    set({ newChatHost: { ...PICK, agent: 'claude', selection: { ...selection, ...scope } } });
    impl['acp.startHostAcpThread'] = async () => 'acp:host-claude:unmatched';
    await S.createChatThread('other');
    assert.equal(st().chatConfig['acp:host-claude:unmatched']?.hostSelection, undefined);
  }
});

test('new machine permissions belong to the captured draft and first-tier agent, with Host default independent of Mac', async () => {
  set({ newChatProjectId: null, newChatCwd: null });
  for (const family of ['claude', 'codex']) {
    for (const permission of [undefined, 'read-only'] as const) {
      set({
        newChatHost: { ...PICK, agent: family, permission: permission ? { hostId: 'box', harness: family, value: permission } : undefined },
      });
      machineAgents([family, 'ready']);
      const id = `acp:host-${family}:${permission ?? 'default'}`;
      impl['acp.startHostAcpThread'] = async () => {
        set({ newChatHost: { ...PICK, agent: 'kimi', permission: { hostId: 'box', harness: 'kimi', value: 'full-access' } } });
        return id;
      };
      await S.createChatThread('permissions');
      assert.deepEqual(st().chatConfig[id].hostPermission, { hostId: 'box', harness: family, value: permission ?? 'default' });
      assert.equal(st().newChatHost?.permission?.value, 'full-access');
    }
  }
  set({ newChatHost: { ...PICK, agent: 'kimi', permission: { hostId: 'box', harness: 'kimi', value: 'full-access' } } });
  machineAgents(['kimi', 'ready']);
  impl['acp.startHostAcpThread'] = async () => 'acp:kimi:permissions';
  await S.createChatThread('ACP');
  assert.equal(st().chatConfig['acp:kimi:permissions']?.hostPermission, undefined);
});

test('C3: a machine picked with no folder says what is true: offline says so with Check again, online is asked for a folder', async () => {
  const bare = { id: 'box', name: 'build-box', path: '' };
  const toasts = () => st().toasts.map((x: any) => x.text ?? x.message);
  const row = (status: string) => ({
    machines: [{ id: 'box', name: 'build-box', status, note: '', signin: null, agents: [], capabilities: {} }],
    resolved: true,
  });
  set({ newChatTemporary: false });
  impl['host.machines'] = async () => row('online');
  assert.equal(await createHostChatThread(bare), null);
  assert.deepEqual(toasts(), ['Pick a folder on build-box.']);
  set({ toasts: [] });
  impl['host.machines'] = async () => row('offline');
  assert.equal(await createHostChatThread(bare), null);
  assert.deepEqual(toasts(), ['build-box is offline. Check again, or pick another machine.']);
  const action = st().toasts[0].action;
  assert.equal(action.label, 'Check again');
  action.run();
  await new Promise((r) => setImmediate(r));
  assert.equal(callsOf('host.check').length, 1);
});

test('C3: a failed Check again on the offline toast says why', async () => {
  const bare = { id: 'box', name: 'build-box', path: '' };
  set({ newChatTemporary: false, toasts: [] });
  impl['host.machines'] = async () => ({
    machines: [{ id: 'box', name: 'build-box', status: 'offline', note: '', signin: null, agents: [], capabilities: {} }],
    resolved: true,
  });
  impl['host.check'] = async () => {
    throw new Error('no route to host');
  };
  assert.equal(await createHostChatThread(bare), null);
  st().toasts[0].action.run();
  await new Promise((r) => setImmediate(r));
  assert.match(st().toasts.at(-1).text ?? st().toasts.at(-1).message, /no route to host/);
});

test('a start on a machine is remembered there: the next new chat on it starts on that agent, model and effort, until the machine is removed', async () => {
  const { forgetHostMachine } = await import('../src/store/projects.ts');
  machineAgents(['claude', 'ready'], ['codex', 'ready']);
  impl['acp.startHostAcpThread'] = async (o: any) => `acp:host-${o.harness}:${callsOf('acp.startHostAcpThread').length}`;
  const selection = { hostId: 'box', harness: 'claude', model: 'opus', effort: 'high' };
  set({ prefs: { ...st().prefs, defaultHarness: 'codex', hostPicks: {} }, newChatProjectId: null, newChatCwd: null });
  set({ newChatHost: { ...PICK, agent: 'claude', selection } });
  assert.equal(await S.createChatThread('hello'), 'acp:host-claude:1');
  assert.deepEqual(st().prefs.hostPicks, { box: { agent: 'claude', model: 'opus', effort: 'high' } });
  assert.deepEqual(st().chatConfig['acp:host-claude:1'].hostSelection, selection);
  // the next draft on the machine, with nothing picked: the machine's last agent, not the saved default
  set({ newChatHost: PICK });
  assert.equal(await S.createChatThread('hello'), 'acp:host-claude:2');
  assert.deepEqual(st().prefs.hostPicks.box, { agent: 'claude' }, "an agent's default model is remembered as no model");
  // the remembered agent signed out there since: the saved default, quietly
  machineAgents(['claude', 'signin'], ['codex', 'ready']);
  assert.equal(await S.createChatThread('hello'), 'acp:host-codex:3');
  assert.equal(st().toasts.length, 0);
  // a selection made for another agent is not this start's
  set({ newChatHost: { ...PICK, agent: 'codex', selection } });
  assert.equal(await S.createChatThread('hello'), 'acp:host-codex:4');
  assert.deepEqual(st().prefs.hostPicks.box, { agent: 'codex' });
  assert.equal(st().chatConfig['acp:host-codex:4']?.hostSelection, undefined);
  forgetHostMachine('box');
  assert.deepEqual(st().prefs.hostPicks, {});
  assert.deepEqual(st().prefs.hostFolders, {});
});

test('a removed machine with only remembered picks (no folder) still forgets them, and an unknown one changes nothing', async () => {
  const { forgetHostMachine } = await import('../src/store/projects.ts');
  set({ prefs: { ...st().prefs, hostFolders: {}, hostPicks: { box: { agent: 'claude' }, mini: { agent: 'codex' } } } });
  forgetHostMachine('box');
  assert.deepEqual(st().prefs.hostPicks, { mini: { agent: 'codex' } });
  const before = st().prefs;
  forgetHostMachine('gone');
  assert.equal(st().prefs, before);
});

test('a remote send with no draft pick starts on the last used harness while new chats follow it, else the saved default', async () => {
  set({ newChatProjectId: null, newChatCwd: null, newChatHost: PICK, newChatHarnessPick: null });
  impl['acp.startHostAcpThread'] = async (o: any) => `acp:host-${o.harness}:1`;
  set({ prefs: { ...st().prefs, defaultHarness: 'codex', lastHarness: 'claude', hostPicks: {}, newChatStart: 'last' } });
  assert.equal(await S.createChatThread('hello'), 'acp:host-claude:1');
  set({ newChatHost: PICK, prefs: { ...st().prefs, hostPicks: {}, newChatStart: 'default' } });
  assert.equal(await S.createChatThread('hello'), 'acp:host-codex:1');
});
