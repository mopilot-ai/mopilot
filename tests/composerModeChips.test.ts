// The composer draws no Remote Control chip: the link shows in the summary panel's Session section, so
// ComposerModeChips carries only the host chip, the permission or mode picker, and the Goal and Plan chips.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, click, mockTsx, mount } from './support/composer-kit.ts';
import { render } from './support/shell-panels-kit.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

mock.module('../src/components/momo/useMomoChat.ts', { namedExports: { useMomoChat: () => null } });
let hostAllowed = false;
let hostAnswered = true;
mock.module('../src/lib/host.ts', {
  namedExports: { useHostAccess: () => hostAllowed, useHostAnswered: () => hostAnswered, hostAllowedNow: () => hostAllowed },
});
let liveMachines: unknown[] = [];
let machinesResolved = true;
let registryUnreadable = false;
let agentChoice: unknown = null;
mock.module('../src/session/useHostAgentChoice.ts', { namedExports: { useHostAgentChoice: () => agentChoice } });
mock.module('../src/lib/hostMachines.ts', {
  namedExports: {
    useHostMachines: () => ({ machines: liveMachines, resolved: machinesResolved, registryUnreadable }),
    readMachineAgents: async () => [],
    readMachineRow: async () => undefined,
  },
});
mock.module('../src/lib/hostSignin.ts', {
  namedExports: {
    useHostSignins: () => new Map(),
    RUNNING: new Set(),
    wantsCode: () => false,
    signinKey: (h: string, a: string) => `${h}\n${a}`,
    startSignin: async () => undefined,
    cancelSignin: async () => undefined,
    sendSigninCode: async () => true,
  },
});
const { createElement: el } = await import('react');
mockTsx(new URL('../src/components/composer/ComposerMenus.tsx', import.meta.url), {
  ModePicker: () => el('i', { className: 'mode-picker' }),
  PermissionPicker: () => el('i', { className: 'permission-picker' }),
});

mockTsx(new URL('../src/components/composer/HostPermissionPicker.tsx', import.meta.url), {
  HostPermissionPicker: () => el('i', { className: 'host-permission-picker' }),
});

let ownerHost: string | null = null;
installNative(
  fakeNative({
    host: {
      owner: async () => (ownerHost ? { hostId: ownerHost } : null),
      remoteChats: async () => (ownerHost ? [{ chatId: 't1', hostId: ownerHost }] : []),
    },
  }),
);
const { resetHostChats } = await import('../src/lib/hostChats.ts');

const { act, createElement } = await import('react');
const { closeAddMachine, useAddMachineOpen } = await import('../src/lib/addMachine.ts');
/** Shows the Add a machine sheet's open state, as the app-level sheet reads it. */
const OpenProbe = () => el('i', { className: 'add-machine-open' }, useAddMachineOpen() ? 'open' : 'closed');
const { ComposerModeChips } = await import('../src/components/composer/ComposerModeChips.tsx');

test('the mode chips draw no Remote Control chip', async () => {
  hostAllowed = true;
  const m = await mount(
    createElement(ComposerModeChips, {
      threadId: 't1',
      basic: null,
      harness: 'claude',
      goalMode: true,
      planMode: true,
      onClearGoal: () => {},
      onClearPlan: () => {},
    }),
  );
  try {
    assert.ok($('.goal-chip', m.host) && $('.plan-chip', m.host));
    assert.equal(m.host.querySelector('[aria-label="Remote Control"]'), null);
    assert.equal(m.host.textContent?.includes('Remote Control'), false);
  } finally {
    hostAllowed = false;
    await m.unmount();
  }
});

test('the host chip’s Add machine… opens the Add a machine sheet through its store and leaves the page alone', async () => {
  hostAllowed = true;
  const { useStore } = await import('../src/store/core.ts');
  const m = await mount(
    createElement(ComposerModeChips, {
      threadId: 't1',
      basic: null,
      harness: 'claude',
      goalMode: false,
      planMode: false,
      onClearGoal: () => {},
      onClearPlan: () => {},
    }),
  );
  const probe = await mount(createElement(OpenProbe));
  assert.equal($('i.add-machine-open', probe.host)?.textContent, 'closed');
  try {
    await click($('button.host-chip', m.host));
    const add = [...document.querySelectorAll('[role=menu] [role^=menuitem]')].find((r) => r.textContent?.includes('Add machine'))!;
    await click(add);
    assert.equal($('i.add-machine-open', probe.host)?.textContent, 'open');
    assert.notDeepEqual((useStore.getState() as any).route, { name: 'settings', section: 'connections' });
  } finally {
    await act(async () => closeAddMachine());
    hostAllowed = false;
    await probe.unmount();
    await m.unmount();
  }
});

test('a basic agent’s chat has its mode picker; a chat that runs Claude Code or Codex on a machine has none, since its permission mode is the machine’s', async () => {
  const props = { threadId: 't1', harness: null, goalMode: false, planMode: false, onClearGoal: () => {}, onClearPlan: () => {} };
  for (const [basic, pickers] of [
    ['kimi', 1],
    ['host-claude', 0],
    ['host-codex', 0],
  ] as const) {
    const m = await mount(createElement(ComposerModeChips, { ...props, basic, harness: basic ? null : 'claude' }));
    try {
      assert.equal(m.host.querySelectorAll('.mode-picker').length, pickers, basic);
    } finally {
      await m.unmount();
    }
  }
});

test('a new chat draws no host chip (the context bar’s Run on chip is its one place); a started chat’s chip keeps its own machine', async () => {
  hostAllowed = true;
  liveMachines = [{ id: 'mini', name: 'mac-mini-test', status: 'online', note: 'SSH · claude' }];
  const { useStore } = await import('../src/store/core.ts');
  const prefs = useStore.getState().prefs;
  useStore.setState({
    newChatProjectId: null,
    newChatCwd: null,
    newChatHost: null,
    prefs: { ...prefs, hostFolders: { mini: '/srv/app' } },
  });
  const props = { basic: null, harness: null, goalMode: false, planMode: false, onClearGoal: () => {}, onClearPlan: () => {} };
  const m = await mount(createElement(ComposerModeChips, { ...props, threadId: null }));
  const row = (name: string) =>
    [...document.querySelectorAll('[role=menu] [role=menuitemradio]')].find((r) => r.querySelector('.menu-title')?.textContent === name)!;
  try {
    assert.equal(m.host.querySelector('button.host-chip'), null);
  } finally {
    await m.unmount();
  }
  // a started chat's chip follows its owner, not the new-chat pick, and its rows pick nothing (another machine's row switches it)
  useStore.setState({ newChatHost: { id: 'mini', name: 'mac-mini-test', path: '/srv/app' } });
  const started = await mount(createElement(ComposerModeChips, { ...props, threadId: 't1' }));
  try {
    assert.equal($('button.host-chip', started.host).getAttribute('aria-label'), 'Host: This Mac, online');
    await click($('button.host-chip', started.host));
    assert.equal(row('This Mac').getAttribute('aria-disabled'), 'true', 'its own machine is inert');
    await click(row('mac-mini-test'));
    assert.deepEqual(useStore.getState().newChatHost, { id: 'mini', name: 'mac-mini-test', path: '/srv/app' }, 'nothing is re-picked');
  } finally {
    hostAllowed = false;
    liveMachines = [];
    useStore.setState({ newChatHost: null, prefs });
    await started.unmount();
  }
});

test('a machine first-tier chat has its Host permission picker; ACP keeps a locked chip', async () => {
  hostAllowed = true;
  resetHostChats();
  ownerHost = 'ssh:me@box';
  liveMachines = [{ id: 'ssh:me@box', name: 'box', status: 'online', note: '', agents: [] }];
  const props = {
    threadId: 't1',
    harness: null,
    goalMode: false,
    planMode: false,
    onClearGoal: () => {},
    onClearPlan: () => {},
  };
  try {
    for (const basic of [null, 'kimi', 'host-claude']) {
      const m = await mount(createElement(ComposerModeChips, { ...props, basic, harness: basic ? null : 'claude' }));
      try {
        if (basic === 'kimi') {
          const chip = $('.host-mode-chip', m.host) as HTMLButtonElement;
          assert.equal(chip.disabled, true);
          assert.equal(chip.textContent, 'Set on box');
        } else assert.equal(m.host.querySelectorAll('.host-permission-picker').length, 1);
        assert.equal(m.host.querySelectorAll('.mode-picker, .permission-picker').length, 0);
      } finally {
        await m.unmount();
      }
    }
  } finally {
    hostAllowed = false;
    ownerHost = null;
    liveMachines = [];
  }
});

test("a new chat's machine pick goes when a machine this window saw listed is gone, never one that was not listed yet", async () => {
  hostAllowed = true;
  const { useStore } = await import('../src/store/core.ts');
  const box = { id: 'ssh:me@box', name: 'box', status: 'online', note: '', agents: [] };
  const gone = { ...box, id: 'ssh:me@gone', name: 'gone' };
  const pick = { id: gone.id, name: 'gone', path: '/w' };
  const props = { harness: null, basic: null, goalMode: false, planMode: false, onClearGoal: () => {}, onClearPlan: () => {} };
  const pickOf = () => (useStore.getState() as any).newChatHost;
  useStore.setState({ newChatProjectId: null, newChatCwd: null, newChatHost: pick } as any);
  // a machine just added is not in the list yet: its pick stays
  liveMachines = [box];
  const m = await render(createElement(ComposerModeChips, { ...props, threadId: null }));
  try {
    assert.deepEqual(pickOf(), pick);
    // it shows up, then is removed elsewhere: the pick goes with it
    liveMachines = [box, gone];
    await m.rerender(createElement(ComposerModeChips, { ...props, threadId: null }));
    assert.deepEqual(pickOf(), pick);
    liveMachines = [box];
    await m.rerender(createElement(ComposerModeChips, { ...props, threadId: 't1' }));
    assert.equal(pickOf(), null, 'the new-chat choice is retired even while a started chat is visible');
    await m.rerender(createElement(ComposerModeChips, { ...props, threadId: null }));
    assert.equal(pickOf(), null);
  } finally {
    hostAllowed = false;
    liveMachines = [];
    await m.unmount();
  }
});

test('a remembered draft survives an unsettled list and an offline device, and clears when that device is removed', async () => {
  const { useStore } = await import('../src/store/core.ts');
  const { clearNewChatProject } = await import('../src/store/chats.ts');
  const { prefs } = useStore.getState();
  const host = { id: 'offline-builder', name: 'Build box' };
  const props = { threadId: null, harness: null, basic: null, goalMode: false, planMode: false, onClearGoal() {}, onClearPlan() {} };
  useStore.setState({ prefs: { ...prefs, lastNewChatHost: host } });
  clearNewChatProject(true);
  hostAllowed = false;
  liveMachines = [];
  const m = await render(createElement(ComposerModeChips, props));
  try {
    assert.equal(useStore.getState().newChatHost?.id, host.id);
    const local = $('button.host-chip', m.host);
    assert.equal(local.textContent, 'Use This Mac');
    assert.equal(local.getAttribute('title'), 'Host access is unavailable');
    await click(local);
    assert.equal(useStore.getState().newChatHost, null);
    await act(async () => {
      useStore.setState({ prefs: { ...prefs, lastNewChatHost: host } });
      clearNewChatProject(true);
    });
    hostAnswered = false;
    await m.rerender(createElement(ComposerModeChips, props));
    assert.equal(m.host.querySelector('button.host-chip'), null);
    hostAnswered = true;
    hostAllowed = true;
    machinesResolved = false;
    await m.rerender(createElement(ComposerModeChips, props));
    assert.equal(useStore.getState().newChatHost?.id, host.id);

    machinesResolved = true;
    liveMachines = [{ ...host, status: 'offline', note: '', agents: [] }];
    await m.rerender(createElement(ComposerModeChips, props));
    // an offline device keeps the pick (the context bar's Run on chip names it; the footer draws no host chip for a new chat)
    assert.equal(useStore.getState().newChatHost?.id, host.id);
    assert.equal(m.host.querySelector('button.host-chip'), null);
    assert.deepEqual(useStore.getState().prefs.lastNewChatHost, host);

    liveMachines = [];
    await m.rerender(createElement(ComposerModeChips, props));
    assert.equal(useStore.getState().newChatHost, null, 'a removed device: the new chat runs on this Mac');
    assert.deepEqual(useStore.getState().prefs.lastNewChatHost, host, 'only main reconciles the saved preference');

    const missing = { id: 'never-listed-here', name: 'Removed machine' };
    registryUnreadable = true;
    await act(async () => {
      useStore.setState({ prefs: { ...prefs, lastNewChatHost: missing } });
      clearNewChatProject(true);
    });
    assert.equal(useStore.getState().newChatHost?.id, missing.id, 'an unreadable registry does not discard the saved choice');
    await act(async () => useStore.setState({ prefs: { ...prefs, lastNewChatHost: host } }));
    registryUnreadable = false;
    await m.rerender(createElement(ComposerModeChips, props));
    assert.equal(useStore.getState().newChatHost, null, 'an unseen removed device retires even when another device is now remembered');
    assert.deepEqual(useStore.getState().prefs.lastNewChatHost, host);
  } finally {
    hostAllowed = false;
    hostAnswered = true;
    liveMachines = [];
    machinesResolved = true;
    registryUnreadable = false;
    useStore.setState({ newChatHost: null, prefs });
    await m.unmount();
  }
});

test("a new chat on a machine: Claude Code or Codex (the ready agent, else the one asked for) gets the machine's menu; another agent the locked chip", async () => {
  const { useStore } = await import('../src/store/core.ts');
  hostAllowed = true;
  liveMachines = [{ id: 'mini', name: 'mac-mini-test', status: 'online', note: '', agents: [] }];
  useStore.setState({ newChatProjectId: null, newChatCwd: null, newChatHost: { id: 'mini', name: 'mac-mini-test', path: '/srv/app' } });
  const props = {
    threadId: null,
    basic: null,
    harness: null,
    goalMode: false,
    planMode: false,
    onClearGoal: () => {},
    onClearPlan: () => {},
  };
  try {
    for (const [choice, picker] of [
      [{ want: 'kimi', choice: { harness: 'codex' } }, 1],
      [{ want: 'claude', choice: null }, 1],
      [{ want: 'kimi', choice: { harness: null } }, 0],
      [null, 0],
    ] as const) {
      agentChoice = choice;
      const m = await mount(createElement(ComposerModeChips, props));
      try {
        assert.equal(m.host.querySelectorAll('.host-permission-picker').length, picker, JSON.stringify(choice));
        assert.equal(m.host.querySelectorAll('.host-mode-chip').length, 1 - picker, JSON.stringify(choice));
      } finally {
        await m.unmount();
      }
    }
  } finally {
    agentChoice = null;
    hostAllowed = false;
    liveMachines = [];
    useStore.setState({ newChatHost: null });
  }
});
