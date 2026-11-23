// A new chat's Run on chip (src/components/composer/RunOnChip.tsx, HostChip's 'ctx' look): the one place a new chat picks where it runs, this Mac, a machine (one with no folder yet opens its folder picker) or a Codex Cloud environment, each pick dropping the other; Add machine… opens the add sheet in place and a machine added there becomes the pick. Without Host the context bar keeps its plain Work in menu (ComposerBars.tsx), and a machine pick names only its folder on the project chip.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import './support/dom.ts';
import { $, $$, click, mockTsx, mount } from './support/composer-kit.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

let hostAllowed = true;
mock.module('../src/lib/host.ts', {
  namedExports: { useHostAccess: () => hostAllowed, useHostAnswered: () => true, hostAllowedNow: () => hostAllowed },
});
let liveMachines: unknown[] = [];
mock.module('../src/lib/hostMachines.ts', {
  namedExports: {
    useHostMachines: () => ({ machines: liveMachines, resolved: true }),
    readMachineAgents: async () => [],
    readMachineRow: async () => undefined,
  },
});
const opened: string[] = [];
mock.module('../src/session/open.ts', { namedExports: { openLink: (u: string) => void opened.push(u) } });
const { createElement: el, useEffect } = await import('react');
// an ssh question under way: the real sheet calls onOpen from an effect on [prompt, onOpen]
let prompting = false;
// the add sheet as its opener drives it: every way it can hand back
mockTsx(new URL('../src/components/pages/settings/AddMachineSheet.tsx', import.meta.url), {
  AddMachineSheet: (p: any) => {
    useEffect(() => {
      if (prompting) p.onOpen();
    }, [p.onOpen]);
    return p.open
      ? el(
          'div',
          { className: 'fake-sheet' },
          el('button', { className: 'start', onClick: () => p.onStartChat?.({ id: 'new', name: 'new-box' }) }),
          el('button', { className: 'close', onClick: p.onClose }),
          el('button', { className: 'cloud', onClick: () => p.onCloud?.() }),
        )
      : el('button', { className: 'reopen', onClick: p.onOpen });
  },
});
mockTsx(new URL('../src/components/composer/HostFolderPicker.tsx', import.meta.url), {
  HostFolderPicker: (p: any) => el('button', { className: 'folder-picker', 'data-host': p.hostId, onClick: () => p.onPick('/srv/new') }),
});
mockTsx(new URL('../src/components/pages/settings/NewCloudMachineSheet.tsx', import.meta.url), {
  NewCloudMachineSheet: () => el('i', { className: 'new-cloud' }),
});
let envs: () => Promise<{ envs?: { id: string; label: string }[]; error?: string }> = async () => ({ envs: [] });
let cloudMachines = false;
installNative(fakeNative({ cloud: { envs: () => envs() }, flags: { isEnabled: (k: string) => cloudMachines && k === 'host.cloud' } }));

const { useStore } = await import('../src/store/core.ts');
const { RunOnChip } = await import('../src/components/composer/RunOnChip.tsx');

const chip = () => $('button.host-ctx');
const row = (name: string) =>
  $$('[role=menu] [role^=menuitem]').find((r) => r.querySelector('.menu-title')?.textContent === name) as HTMLElement;
const titles = () => $$('[role=menu] [role^=menuitem]').map((r) => r.querySelector('.menu-title')?.textContent);
const settle = async (n = 5) => {
  for (let i = 0; i < n; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
};
const waitFor = async <T>(fn: () => T | null | undefined): Promise<T> => {
  for (let i = 0; i < 300; i++) {
    const v = fn();
    if (v) return v;
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  throw new Error('timed out');
};
const reset = () => {
  const prefs = useStore.getState().prefs;
  useStore.setState({
    newChatProjectId: null,
    newChatCwd: null,
    newChatHost: null,
    newChatCloudEnv: null,
    prefs: { ...prefs, hostFolders: { mini: '/srv/app' } },
  });
};

test('the chip always names where the chat runs; a machine row picks it, This Mac drops it', async () => {
  reset();
  liveMachines = [{ id: 'mini', name: 'mac-mini-test', status: 'online', note: '' }];
  const m = await mount(el(RunOnChip, { cloudCap: false }));
  try {
    assert.equal(chip().getAttribute('aria-label'), 'Run on: This Mac, online');
    assert.equal($('.host-name', chip()).textContent, 'This Mac', 'named even with one machine to pick');
    await click(chip());
    assert.deepEqual(titles(), ['This Mac', 'mac-mini-test', 'Add machine…', 'Switch host…'], 'no cloud group for an agent without one');
    await click(row('mac-mini-test'));
    assert.equal(useStore.getState().newChatHost?.id, 'mini');
    assert.equal(chip().getAttribute('aria-label'), 'Run on: mac-mini-test, online');
    await click(chip());
    await click(row('This Mac'));
    assert.equal(useStore.getState().newChatHost, null);
  } finally {
    await m.unmount();
  }
});

test('Codex Cloud: its environments are one more group; picking one drops the machine, picking a machine drops it', async () => {
  reset();
  liveMachines = [{ id: 'mini', name: 'mac-mini-test', status: 'online', note: '' }];
  let answer: (v: { envs?: { id: string; label: string }[]; error?: string }) => void = () => undefined;
  envs = () => new Promise((r) => (answer = r));
  const m = await mount(el(RunOnChip, { cloudCap: true }));
  try {
    await click(chip());
    await click(row('mac-mini-test'));
    await click(chip());
    assert.ok(titles().includes('Loading environments…'));
    await act(async () => answer({ envs: [{ id: 'e1', label: 'web-app' }] }));
    await settle();
    assert.ok($$('.menu-section-label').some((l) => l.textContent === 'Codex Cloud'));
    await click(row('web-app'));
    assert.deepEqual(useStore.getState().newChatCloudEnv, { id: 'e1', label: 'web-app' });
    assert.equal(useStore.getState().newChatHost, null, 'the machine pick goes');
    assert.equal(chip().getAttribute('aria-label'), 'Run on: web-app');
    assert.equal($('.host-name', chip()).textContent, 'web-app');
    await click(chip());
    assert.equal(row('web-app').getAttribute('aria-checked'), 'true');
    assert.ok(
      $$('[role=menu] [role=menuitemradio]')
        .filter((r) => r !== row('web-app'))
        .every((r) => r.getAttribute('aria-checked') === 'false'),
      'no machine is checked while a cloud environment is',
    );
    await click(row('mac-mini-test'));
    assert.equal(useStore.getState().newChatCloudEnv, null);
    assert.equal(useStore.getState().newChatHost?.id, 'mini');
    // a machine picked with no cloud environment set leaves the store's environment alone
    await click(chip());
    await click(row('This Mac'));
    assert.equal(useStore.getState().newChatCloudEnv, null);
    await click(chip());
    await click(row('Manage environments'));
    assert.deepEqual(opened, ['https://chatgpt.com/codex/settings/environments']);
  } finally {
    await m.unmount();
  }
});

test('B: Codex Cloud with no environments says why, or that there are none', async () => {
  reset();
  liveMachines = [];
  for (const [given, said] of [
    [async () => ({ envs: [], error: 'Sign in to Codex Cloud' }), 'Sign in to Codex Cloud'],
    [async () => ({}), 'No cloud environments'],
    [async () => Promise.reject(new Error('cloud is down')), 'cloud is down'],
  ] as const) {
    envs = given;
    const m = await mount(el(RunOnChip, { cloudCap: true }));
    try {
      await click(chip());
      await settle();
      assert.ok(titles().includes(said), `${said}: ${titles().join(', ')}`);
    } finally {
      await m.unmount();
    }
  }
});

test('Add machine… opens the sheet in place; a machine added there becomes the new chat’s pick and opens its folder picker', async () => {
  reset();
  liveMachines = [];
  const m = await mount(el(RunOnChip, { cloudCap: false }));
  try {
    await click(chip());
    await click(row('Add machine…'));
    const sheet = await waitFor(() => $('.fake-sheet'));
    // closed while an install may run, it stays mounted and opens again when asked (an ssh question)
    await click($('.close', sheet));
    await click($('.reopen'));
    // host.cloud off: the sheet offers no cloud machine
    await click($('.cloud'));
    assert.equal($('.new-cloud'), null);
    assert.ok($('.fake-sheet'), 'nothing happened');
    await click($('.close'));
    await click(chip());
    await click(row('Add machine…'));
    await click($('.start'));
    assert.equal($('.fake-sheet'), null, 'the sheet closes');
    assert.deepEqual({ id: useStore.getState().newChatHost?.id, path: useStore.getState().newChatHost?.path }, { id: 'new', path: '' });
    assert.equal($('.folder-picker').getAttribute('data-host'), 'new', 'no folder used there yet: the picker opens');
    await click($('.folder-picker'));
    assert.equal(useStore.getState().newChatHost?.path, '/srv/new');
  } finally {
    await m.unmount();
  }
});

test('host.cloud: the add sheet’s New cloud machine… closes it and opens the cloud sheet', async () => {
  reset();
  liveMachines = [];
  cloudMachines = true;
  const m = await mount(el(RunOnChip, { cloudCap: false }));
  try {
    await click(chip());
    await click(row('Add machine…'));
    await click(await waitFor(() => $('.fake-sheet .cloud')));
    assert.equal($('.fake-sheet'), null);
    await waitFor(() => $('.new-cloud'));
  } finally {
    cloudMachines = false;
    await m.unmount();
  }
});

test('B: while ssh asks a question, Close still closes the sheet (its opener’s callbacks are stable across renders)', async () => {
  reset();
  liveMachines = [];
  const m = await mount(el(RunOnChip, { cloudCap: false }));
  try {
    await click(chip());
    await click(row('Add machine…'));
    await waitFor(() => $('.fake-sheet'));
    prompting = true;
    await click($('.fake-sheet .close'));
    await settle();
    assert.equal($('.fake-sheet'), null, 'closed, and not reopened by its own render');
  } finally {
    prompting = false;
    await m.unmount();
  }
});
