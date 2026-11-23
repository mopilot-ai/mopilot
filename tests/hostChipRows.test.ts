// The host chip's machine rows: for a new chat a row picks the machine (and an online one with no folder used there opens its folder picker); for a chat that has started another machine's row opens Switch host with it picked, or says why switching is off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, mount } from './support/composer-kit.ts';

import { mockSource } from './support/stubs.ts';
import type { HostMachine } from '../src/components/composer/HostChip.tsx';

const { createElement: h } = await import('react');
const unattended = false;
mockSource('src/lib/flags.ts', {
  useFlag: (k: string) => k === 'host.unattended' && unattended,
  isEnabled: (k: string) => k === 'host.unattended' && unattended,
});
mockSource('src/lib/host.ts', { useHostAccess: () => true });
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines: [], resolved: true }) });
mockSource('src/lib/hostSignin.ts', {
  useHostSignins: () => new Map(),
  RUNNING: new Set(),
  wantsCode: () => false,
  signinKey: (a: string, b: string) => `${a}\n${b}`,
  startSignin: async () => undefined,
  cancelSignin: async () => undefined,
  sendSigninCode: async () => true,
});
const picks: { id: string; name: string }[] = [];
const folders: [string, string][] = [];
// what the store answers for the pick: the folder last used on the machine, if any
let remembered: Record<string, string> = {};
const NEW_CHAT = {
  onPick: (m: { id: string; name: string }) => {
    picks.push({ id: m.id, name: m.name });
    return m.id === 'local' ? null : { path: remembered[m.id] ?? '' };
  },
  onFolder: (m: { id: string }, path: string) => void folders.push([m.id, path]),
};
mockSource('src/components/composer/HostFolderPicker.tsx', {
  HostFolderPicker: (p: { hostId: string; name: string; onPick: (path: string) => void; onClose: () => void }) =>
    h('div', { role: 'dialog', 'aria-label': `Folder on ${p.name}` }, [
      h('button', { key: 'use', className: 'use', onClick: () => p.onPick('/srv/app') }, 'Use this folder'),
      h('button', { key: 'x', className: 'cancel', onClick: p.onClose }, 'Cancel'),
    ]),
});
const { HostChip } = await import('../src/components/composer/HostChip.tsx');

const FLEET: HostMachine[] = [
  { id: 'local', name: 'This Mac', status: 'online', note: 'Browser, Computer use' },
  { id: 'mini', name: 'mac-mini-test', status: 'online', note: 'SSH · claude', capabilities: { iab: true, cu: false } },
  { id: 'box', name: 'build-box', status: 'offline', note: 'Offline' },
];
const machineRows = () => $$('[role=menu] [role=menuitemradio]');
const row = (name: string) => machineRows().find((r) => $('.menu-title', r).textContent === name)!;
const reset = () => {
  picks.length = 0;
  folders.length = 0;
  remembered = {};
};

test('a new chat: a machine row picks it and closes the menu; an online machine with no folder yet opens its folder picker', async () => {
  reset();
  const m = await mount(h(HostChip, { machines: FLEET, ...NEW_CHAT }));
  try {
    await click($('button.host-chip'));
    assert.equal($('.perm-mode-note'), null, 'no reason line: the rows can be picked');
    assert.ok(machineRows().every((r) => r.getAttribute('aria-disabled') === null));
    await click(row('mac-mini-test'));
    assert.deepEqual(picks, [{ id: 'mini', name: 'mac-mini-test' }]);
    assert.equal($('[role=menu]'), null);
    assert.equal($('[role=dialog]').getAttribute('aria-label'), 'Folder on mac-mini-test');
    await click($('[role=dialog] .use'));
    assert.deepEqual(folders, [['mini', '/srv/app']]);
    assert.equal($('[role=dialog]'), null, 'the picker closes with the folder');
  } finally {
    await m.unmount();
  }
});

test('a new chat: the folder picker closed with no folder picks none; a machine with a folder used there, an offline one and This Mac open none', async () => {
  reset();
  remembered = { mini: '/srv/app' };
  const m = await mount(h(HostChip, { machines: FLEET, ...NEW_CHAT }));
  try {
    for (const name of ['mac-mini-test', 'build-box', 'This Mac']) {
      await click($('button.host-chip'));
      await click(row(name));
      assert.equal($('[role=dialog]'), null, name);
    }
    assert.deepEqual(
      picks.map((p) => p.id),
      ['mini', 'box', 'local'],
    );
    remembered = {};
    await click($('button.host-chip'));
    await click(row('mac-mini-test'));
    await click($('[role=dialog] .cancel'));
    assert.equal($('[role=dialog]'), null);
    assert.deepEqual(folders, []);
  } finally {
    await m.unmount();
  }
});

test('a new chat: the check mark and the chip follow the machine picked (ownerId)', async () => {
  reset();
  const m = await mount(h(HostChip, { machines: FLEET, ownerId: 'box', ...NEW_CHAT }));
  try {
    assert.equal($('button.host-chip').getAttribute('aria-label'), 'Host: build-box, offline');
    await click($('button.host-chip'));
    assert.deepEqual(
      machineRows().map((r) => r.getAttribute('aria-checked')),
      ['false', 'false', 'true'],
    );
    assert.ok($('.menu-check svg', row('build-box')));
    assert.equal($('.menu-check', row('This Mac')).childElementCount, 0);
  } finally {
    await m.unmount();
  }
});

const LX: HostMachine = { id: 'lx', name: 'linux-box', status: 'online', note: 'SSH · codex' };
const checked = () => $$('[role=dialog] [role=radio]').filter((r) => r.getAttribute('aria-checked') === 'true');
const radioName = (r: Element) => $('.switch-host-name', r).textContent;

test("a started chat: another machine's row opens Switch host with it picked; its own row and an offline one are inert; Switch host… picks none", async () => {
  reset();
  const m = await mount(h(HostChip, { machines: [...FLEET, LX], chatId: 'c1', onContinue: async () => undefined, ...NEW_CHAT }));
  try {
    await click($('button.host-chip'));
    assert.equal($$('.perm-mode-note').length, 0, 'no header sentence: the menu is a picker');
    assert.deepEqual(
      machineRows().map((r) => [r.getAttribute('aria-checked'), r.getAttribute('aria-disabled'), r.getAttribute('title')]),
      [
        ['true', 'true', null],
        ['false', null, null],
        ['false', 'true', null],
        ['false', null, null],
      ],
    );
    await click(row('This Mac'));
    await click(row('build-box'));
    assert.ok($('[role=menu]'), 'an inert row keeps the menu');
    assert.equal($('[role=dialog]'), null);
    await click(row('linux-box'));
    assert.equal($('[role=menu]'), null);
    assert.equal($('[role=dialog] .dialog-head').textContent, 'Switch host');
    assert.deepEqual(checked().map(radioName), ['linux-box'], 'the clicked machine is picked');
    assert.deepEqual(picks, [], 'a started chat never re-picks its machine');
    await click($$('.acct-dialog-actions button')[0]);
    assert.equal($('[role=dialog]'), null);

    await click($('button.host-chip'));
    await click($$('[role=menu] [role=menuitem]').at(-1)!);
    assert.deepEqual(checked().map(radioName), ['mac-mini-test'], 'Switch host… picks the first machine that can take it');
  } finally {
    await m.unmount();
  }
});

test('a started chat that cannot switch now: a machine row stays clickable and says why in its second line; the menu reopens with its note', async () => {
  reset();
  const m = await mount(h(HostChip, { machines: FLEET, chatId: 'c1', turnRunning: true, onContinue: async () => undefined, ...NEW_CHAT }));
  try {
    await click($('button.host-chip'));
    const mini = () => row('mac-mini-test');
    assert.equal(mini().getAttribute('aria-disabled'), null);
    assert.equal(mini().getAttribute('title'), 'Stop the chat first');
    assert.equal($('.menu-desc', mini()).textContent, 'No computer use');
    await click(mini());
    assert.ok($('[role=menu]'), 'the menu stays to say why');
    assert.equal($('[role=dialog]'), null);
    assert.equal($('.menu-desc', mini()).textContent, 'Stop the chat first');
    assert.equal(machineRows().length, 3, 'no row is added');
    await click($('button.host-chip'));
    await click($('button.host-chip'));
    assert.equal($('.menu-desc', mini()).textContent, 'No computer use', 'a reopened menu shows the note again');
  } finally {
    await m.unmount();
  }
});

test('with no pick handlers a row only closes the menu, and a picker with no folder handler just closes', async () => {
  reset();
  const bare = await mount(h(HostChip, { machines: FLEET }));
  try {
    await click($('button.host-chip'));
    await click(row('mac-mini-test'));
    assert.equal($('[role=menu]'), null);
    assert.equal($('[role=dialog]'), null);
  } finally {
    await bare.unmount();
  }
  const half = await mount(h(HostChip, { machines: FLEET, onPick: NEW_CHAT.onPick }));
  try {
    await click($('button.host-chip'));
    await click(row('mac-mini-test'));
    await click($('[role=dialog] .use'));
    assert.equal($('[role=dialog]'), null);
    assert.deepEqual(folders, []);
  } finally {
    await half.unmount();
  }
});
