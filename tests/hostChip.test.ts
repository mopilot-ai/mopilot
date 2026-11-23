// The composer's host chip: one machine, several machines with the three dot states, the disabled Switch host row and its reason, accessible names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import './support/dom.ts';
import { $, $$, click, mount } from './support/composer-kit.ts';

import { mockSource } from './support/stubs.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';
import type { HostMachine } from '../src/components/composer/HostChip.tsx';

let allowed = true;
let live: { machines: HostMachine[]; resolved: boolean } = { machines: [], resolved: true };
let unattended = false;
mockSource('src/lib/flags.ts', {
  useFlag: (k: string) => k === 'host.unattended' && unattended,
  isEnabled: (k: string) => k === 'host.unattended' && unattended,
  // what the add sheet's modules read when it loads in place
  harnessEnabled: () => true,
  useEnabledHarnesses: () => ['codex', 'claude'],
});
mockSource('src/lib/host.ts', { useHostAccess: () => allowed, hostAllowedNow: () => allowed, useHostAnswered: () => true });
mockSource('src/lib/hostMachines.ts', {
  useHostMachines: () => live,
  readMachineAgents: async () => [],
  readMachineRow: async () => undefined,
});
mockSource('src/components/pages/settings/Connections.tsx', {
  openSshTerminal: () => {
    throw new Error('The machine picker must not open a terminal.');
  },
});
const { createElement } = await import('react');
const { HostChip } = await import('../src/components/composer/HostChip.tsx');
const { switchHostReason } = await import('../src/lib/hostSwitch.ts');

const FLEET: HostMachine[] = [
  { id: 'local', name: 'This Mac', status: 'online', note: '' },
  { id: 'box', name: 'build-box', status: 'offline', note: 'Offline' },
  { id: 'lab', name: 'lab', status: 'attention', note: 'Needs login' },
];

const open = async (props: any = {}) => {
  const m = await mount(createElement(HostChip, props));
  await click($('button.host-chip'));
  return m;
};
/** Wait, through React's act, for `fn` to return something (a lazy part loading). */
const until = async <T>(fn: () => T | null | undefined, ms = 3000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
};
const rows = () => $$('[role=menu] [role^=menuitem]');
/** A row's second line; '' when it has none (everything works). */
const desc = (r: Element) => r.querySelector('.menu-desc')?.textContent ?? '';

test('one machine: a name-less chip with a green dot; the menu lists this Mac, Add machine and a disabled Switch host', async () => {
  const m = await open();
  try {
    const chip = $('button.host-chip');
    assert.equal(chip.getAttribute('aria-label'), 'Host: This Mac, online');
    assert.equal(chip.textContent, '');
    assert.equal($('.host-dot', chip).getAttribute('aria-label'), 'Online');
    assert.equal($('[role=menu]').getAttribute('aria-label'), 'My machines');
    // one surface, as the permission picker draws it: the list inside the menu is not a second card
    assert.equal($$('.popover-layer .menu').length, 1, 'a single .menu surface in the popover');
    assert.equal($('[role=menu]').className, 'perm-list');
    assert.equal($$('.perm-menu-head').length, 1);
    assert.equal($$('[role=separator]').length, 1, 'a divider sits between the machines and the actions');
    assert.ok($('[role=separator]').nextElementSibling!.textContent!.startsWith('Add machine'));
    assert.deepEqual(
      rows().map((r) => r.querySelector('.menu-title')!.textContent),
      ['This Mac', 'Add machine…', 'Switch host…'],
    );
    assert.equal(rows()[0].getAttribute('aria-checked'), 'true');
    const add = rows()[1];
    assert.equal(add.getAttribute('aria-disabled'), null, 'Add machine is on');
    assert.equal(add.getAttribute('title'), null);
    assert.equal(rows()[2].getAttribute('aria-disabled'), 'true', 'Switch host stays off');
  } finally {
    await m.unmount();
  }
});

test('several machines: each row carries its dot state and reason; the chip names the owner', async () => {
  const m = await open({ machines: FLEET, ownerId: 'lab' });
  try {
    const chip = $('button.host-chip');
    assert.equal(chip.getAttribute('aria-label'), 'Host: lab, needs attention');
    assert.equal(chip.textContent, 'lab');
    assert.equal($('.host-dot', chip).className, 'host-dot attention');
    const machines = rows().slice(0, 3);
    assert.deepEqual(
      machines.map((r) => [$('.host-dot', r).className, $('.host-dot', r).getAttribute('aria-label'), desc(r)]),
      [
        ['host-dot online', 'Online', ''],
        ['host-dot offline', 'Offline', 'Offline'],
        ['host-dot attention', 'Needs attention', 'Needs login'],
      ],
    );
    assert.deepEqual(
      machines.map((r) => r.getAttribute('aria-checked')),
      ['false', 'false', 'true'],
    );
    // a row with nothing to say is one line (Claude Desktop's density); only a row with a state or limit has two
    assert.deepEqual(
      machines.map((r) => r.classList.contains('has-desc')),
      [false, true, true],
    );
  } finally {
    await m.unmount();
  }
});

test('an empty list falls back to this Mac, and a machine that left the list stays the owner, offline, never swapped for another (the host is not re-picked)', async () => {
  const empty = await mount(createElement(HostChip, { machines: [] }));
  assert.equal($('button.host-chip').getAttribute('aria-label'), 'Host: This Mac, online');
  await empty.unmount();
  const gone = await mount(createElement(HostChip, { machines: FLEET.slice(0, 2), ownerId: 'lab' }));
  assert.equal($('button.host-chip').getAttribute('aria-label'), 'Host: lab, offline');
  await click($('button.host-chip'));
  assert.deepEqual(
    rows().map((r) => $('.menu-title', r).textContent),
    ['lab', 'This Mac', 'build-box', 'Add machine…', 'Switch host…'],
  );
  assert.equal(desc(rows()[0]), 'Offline');
  assert.equal(rows()[0].getAttribute('aria-checked'), 'true');
  await gone.unmount();
});

test("the registry's machines follow This Mac, and the menu says Checking machines… until every one has answered", async () => {
  live = { machines: [{ id: 'box', name: 'build-box', status: 'online', note: 'SSH · claude' }], resolved: false };
  const m = await open();
  try {
    assert.deepEqual(
      rows().map((r) => $('.menu-title', r).textContent),
      ['This Mac', 'build-box', 'Checking machines…', 'Add machine…', 'Switch host…'],
    );
    assert.equal(rows()[2].getAttribute('aria-disabled'), 'true');
    assert.equal(rows()[2].getAttribute('aria-busy'), 'true');
    assert.equal($('button.host-chip').textContent, 'This Mac', 'two machines: the chip names its owner');
  } finally {
    await m.unmount();
  }
  live = { machines: live.machines, resolved: true };
  const done = await open();
  try {
    assert.ok(!rows().some((r) => $('.menu-title', r).textContent === 'Checking machines…'));
  } finally {
    await done.unmount();
    live = { machines: [], resolved: true };
  }
});

test('Add machine… closes the menu and opens where a machine is added: the add sheet in place unless the caller opens its own', async () => {
  let opened = 0;
  const m = await open({ onAddMachine: () => opened++ });
  try {
    await click(rows()[1]);
    assert.equal(opened, 1);
    assert.equal($('[role=menu]'), null);
    assert.equal(document.querySelector('.add-machine-sheet'), null, 'the caller’s own place, not the sheet');
  } finally {
    await m.unmount();
  }
  installNative(fakeNative({ host: { discover: () => new Promise(() => undefined) } }));
  const bare = await open();
  try {
    await click(rows()[1]);
    assert.equal($('[role=menu]'), null);
    // the sheet loads on first use, then the chat never leaves for Settings
    const sheet = await until(() => document.querySelector('.add-machine-sheet'));
    assert.ok(sheet.querySelector('input[aria-label=Machine]'), 'one field, no tabs');
    assert.equal(sheet.querySelectorAll('[role=tab]').length, 0);
  } finally {
    await bare.unmount();
  }
});

test('Switch host is off with its reason: stop the turn, send a message first, or add a machine', async () => {
  const ready = { turnRunning: false, hasChat: true, ownerKnown: true, targets: 1 };
  assert.equal(switchHostReason(ready), null);
  assert.equal(switchHostReason({ ...ready, turnRunning: true }), 'Stop the chat first');
  // #4951: a message sent to the machine whose turn the app has not shown yet (the agent is still starting there) keeps the chat there too
  assert.equal(switchHostReason({ ...ready, queued: true }), 'Wait for your message to send');
  assert.equal(switchHostReason({ ...ready, turnRunning: true, queued: true }), 'Stop the chat first');
  assert.equal(switchHostReason({ ...ready, hasChat: false }), 'Send a message first');
  assert.equal(switchHostReason({ ...ready, ownerKnown: false }), 'Checking the host…');
  assert.equal(switchHostReason({ ...ready, targets: 0 }), 'Add a machine first');
  const onContinue = async () => undefined;
  for (const [props, why] of [
    [{ machines: FLEET }, 'Send a message first'],
    [{ machines: FLEET, chatId: 'c1' }, 'Send a message first'],
    [{ machines: FLEET, chatId: 'c1', onContinue, turnRunning: true }, 'Stop the chat first'],
    [{ machines: FLEET, chatId: 'c1', onContinue, queued: true }, 'Wait for your message to send'],
    [{ machines: FLEET.slice(0, 1), chatId: 'c1', onContinue }, 'Add a machine first'],
    [{ machines: FLEET, chatId: 'c1', onContinue, ownerKnown: false }, 'Checking the host…'],
  ] as const) {
    const m = await open(props);
    try {
      const sw = rows().at(-1)!;
      assert.equal(sw.getAttribute('aria-disabled'), 'true');
      assert.equal(sw.getAttribute('title'), why);
      assert.equal($('.menu-desc', sw).textContent, why);
      await click(sw);
      assert.ok($('[role=menu]'), 'a disabled row does not close the menu');
      assert.equal($('[role=dialog]'), null);
    } finally {
      await m.unmount();
    }
  }
});

test('Switch host… closes the menu and opens the dialog for the chat; it keeps its chat, project and the owner out of the list', async () => {
  const sent: unknown[] = [];
  const m = await open({
    machines: FLEET,
    ownerId: 'local',
    chatId: 'c1',
    project: '/work/app',
    onContinue: async (req: unknown) => void sent.push(req),
  });
  try {
    const sw = rows().at(-1)!;
    assert.equal(sw.getAttribute('aria-disabled'), null);
    assert.equal(sw.getAttribute('title'), null);
    assert.equal($('.menu-desc', sw), null, 'no reason when it is on');
    await click(sw);
    assert.equal($('[role=menu]'), null);
    assert.equal($('[role=dialog]').querySelector('.dialog-head')!.textContent, 'Switch host');
    assert.deepEqual(
      $$('[role=radio] .switch-host-name').map((n) => n.textContent),
      ['build-box', 'lab'],
    );
    await click($$('.acct-dialog-actions button')[0]);
    assert.equal($('[role=dialog]'), null, 'Cancel closes it');
  } finally {
    await m.unmount();
  }
});

test('a chat whose owner is offline lists it again and asks before continuing without it', async () => {
  const sent: any[] = [];
  const m = await open({
    machines: [FLEET[0], { id: 'box', name: 'build-box', status: 'offline', note: 'Offline' }],
    ownerId: 'box',
    chatId: 'c1',
    onContinue: async (req: unknown) => void sent.push(req),
  });
  try {
    await click(rows().at(-1)!);
    assert.deepEqual(
      $$('[role=radio] .switch-host-name').map((n) => n.textContent),
      ['This Mac', 'build-box'],
    );
    const input = $('input[aria-label="Folder on the host"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, '/srv');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await click($$('.acct-dialog-actions button')[1]);
    assert.ok($('.acct-dialog-hint').textContent!.startsWith("build-box isn't reachable."));
    await click($$('.acct-dialog-actions button')[1]);
    assert.deepEqual(sent, [{ chatId: 'c1', targetHostId: 'local', cwd: '/srv', lostHostConfirmed: true }]);
    assert.equal($('[role=dialog]'), null, 'a continue closes the dialog');
  } finally {
    await m.unmount();
  }
  const away = await open({ machines: FLEET, ownerId: 'gone', chatId: 'c1', onContinue: async () => undefined });
  try {
    await click(rows().at(-1)!);
    assert.equal(
      $$('[role=radio]').length,
      3,
      'a machine that left the list is still the owner and still excluded from the targets of a local chat',
    );
  } finally {
    await away.unmount();
  }
});

test('the dialog closes when the chat changes, and a host not yet checked is not taken for a lost one', async () => {
  const onContinue = async () => undefined;
  const props = { machines: FLEET, chatId: 'c1', onContinue };
  const m = await open(props);
  try {
    await click(rows().at(-1)!);
    assert.ok($('[role=dialog]'));
    await m.render(createElement(HostChip, { ...props, chatId: 'c2' }));
    assert.equal($('[role=dialog]'), null, 'another chat does not inherit the open dialog');
  } finally {
    await m.unmount();
  }
  live = {
    machines: [{ id: 'box', name: 'build-box', status: 'offline', note: 'Offline', capabilities: { iab: false, cu: false } }],
    resolved: false,
  };
  const pending = await open({ chatId: 'c1', onContinue, ownerId: 'box' });
  try {
    await click(rows().at(-1)!);
    assert.deepEqual(
      $$('[role=radio] .switch-host-name').map((n) => n.textContent),
      ['This Mac'],
      'the owner is not a target until it is known to be unreachable',
    );
  } finally {
    await pending.unmount();
    live = { machines: [], resolved: true };
  }
});

test('choosing a row only closes the menu; the chat keeps its host', async () => {
  for (const index of [0, 1, 2]) {
    const m = await open({ machines: FLEET });
    try {
      await click(rows()[index]);
      assert.equal($('[role=menu]'), null);
      assert.equal($('button.host-chip').getAttribute('aria-label'), 'Host: This Mac, online');
    } finally {
      await m.unmount();
    }
  }
});

test('narrow composers collapse the host chip to its dot and icon in the 28px square the other chips use', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/styles/app/composer-controls.css', import.meta.url), 'utf8');
  const narrow = css.slice(
    css.indexOf('@container composer (max-width: 520px)'),
    css.indexOf('@container composer (max-width: 420px) {\n  .composer-footer'),
  );
  assert.match(narrow, /\.composer-left \.host-chip \{[^}]*min-width: 28px;[^}]*width: 28px;[^}]*padding: 0;/);
  assert.match(narrow, /\.composer-left \.host-name \{/);
  assert.match(narrow, /\.composer-left \.host-chip > svg \{[^}]*width: 14px;/);
});

test('like Claude Desktop, a narrower composer cuts chip names before it drops them: icons only at 420px and below', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/styles/app/composer-controls.css', import.meta.url), 'utf8');
  // no wider breakpoint strips labels: between 520px and the full width, names shrink with an ellipsis
  const widths = [...css.matchAll(/@container composer \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
  assert.deepEqual([...new Set(widths)].sort(), [420, 520, 640]);
  // 640px folds the left chips only while a Goal or Plan chip crowds them
  const crowded = css.slice(
    css.indexOf('@container composer (max-width: 640px)'),
    css.indexOf('@container composer (max-width: 420px) {\n  .composer-footer'),
  );
  assert.match(crowded, /\.composer-left:has\(\.goal-chip, \.plan-chip\) \.host-chip \{[^}]*min-width: 28px;[^}]*width: 28px;/);
  assert.equal(crowded.replace(/\/\*[^]*?\*\//g, '').match(/^\s*\.composer-left(?!:has\(\.goal-chip, \.plan-chip\))/m), null);
  const mid = css.slice(css.indexOf('@container composer (max-width: 520px)'), css.indexOf('@container composer (max-width: 640px)'));
  assert.doesNotMatch(mid, /model-effort|perm-btn|model-name|model-btn > svg/);
  const tight = css.slice(css.indexOf('@container composer (max-width: 420px) {\n  .composer-footer'), css.indexOf('.host-dot {'));
  assert.match(tight, /\.composer-left \.perm-btn > span,/);
  assert.match(tight, /\.composer-right \.model-btn > svg:last-child \{\s*display: none;/);
});

test('closed alpha: without the Host invite the chip and its menu do not exist; with it they do', async () => {
  allowed = false;
  const off = await mount(createElement(HostChip, {}));
  try {
    assert.equal($$('button.host-chip').length, 0);
    assert.equal($$('.host-dot').length, 0);
  } finally {
    await off.unmount();
  }
  allowed = true;
  const on = await mount(createElement(HostChip, {}));
  try {
    assert.equal($$('button.host-chip').length, 1);
  } finally {
    await on.unmount();
    allowed = true;
  }
});

test('an online machine says only the one thing it cannot do, never the registry note or what it can', async () => {
  const m = await open({
    machines: [
      FLEET[0],
      { id: 'lx', name: 'linux-box', status: 'online', note: 'SSH', capabilities: { iab: true, cu: false } },
      { id: 'mac', name: 'mac-mini', status: 'online', note: 'SSH · claude', capabilities: { iab: true, cu: false, desktop: true } },
      { id: 'old', name: 'old-box', status: 'online', note: 'SSH · codex' },
    ],
  });
  try {
    assert.deepEqual(rows().slice(0, 4).map(desc), ['', 'No computer use', '', '']);
  } finally {
    m.unmount();
  }
});

test('an offline machine keeps its registry note even when it declared capabilities', async () => {
  const m = await open({
    machines: [FLEET[0], { id: 'box', name: 'build-box', status: 'offline', note: 'Offline', capabilities: { iab: true, cu: false } }],
  });
  try {
    assert.equal(rows()[1].querySelector('.menu-desc')!.textContent, 'Offline');
  } finally {
    m.unmount();
  }
});

test("a failed heartbeat's long reason shows in short words on the row and in full as its tooltip", async () => {
  const why = 'Unreachable: This machine has no Host socket on record.';
  const m = await open({
    machines: [FLEET[0], { id: 'box', name: 'build-box', status: 'offline', note: why }, FLEET[2]],
  });
  try {
    assert.deepEqual(
      rows()
        .slice(0, 3)
        .map((r) => [desc(r), r.getAttribute('title')]),
      [
        ['', null],
        ['Offline', why],
        ['Needs login', null],
      ],
    );
  } finally {
    await m.unmount();
  }
});

test('with host.unattended the menu is Run on, This Mac first and the other machines under My machines', async () => {
  unattended = true;
  live = { machines: FLEET.slice(1), resolved: true };
  const m = await open();
  try {
    assert.equal($('[role=menu]').getAttribute('aria-label'), 'My machines', 'the menu keeps its name');
    assert.equal($('.perm-menu-head').textContent, 'Run on');
    assert.deepEqual(
      $$('.menu-section-label').map((e) => e.textContent),
      ['My machines'],
      'one group label, before the first machine that is not this Mac',
    );
    assert.equal($('[role=menu]').children[0].textContent?.startsWith('This Mac'), true);
  } finally {
    unattended = false;
    await m.unmount();
  }
});
