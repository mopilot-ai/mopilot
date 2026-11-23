// The host chip's Cloud group (host.cloud): with the flag on the cloud machines are their own group after the others, each with the line main gives it and its dot, and New cloud machine… opens the sheet; with it off there is no group.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
import type { HostMachine } from '../src/components/composer/HostChip.tsx';

const { createElement: h } = await import('react');
let on = true;
let lines = new Map<string, unknown>();
mockSource('src/lib/flags.ts', { useFlag: () => false, isEnabled: () => false });
mockSource('src/lib/host.ts', { useHostAccess: () => true });
mockSource('src/components/pages/settings/Connections.tsx', {
  openSshTerminal: () => {
    throw new Error('The cloud machine picker must not open a terminal.');
  },
});
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines: [], resolved: true }) });
mockSource('src/lib/hostCloud.ts', { cloudOn: () => on, useCloudLines: () => lines });
mockSource('src/lib/hostSignin.ts', {
  useHostSignins: () => new Map(),
  RUNNING: new Set(),
  wantsCode: () => false,
  signinKey: (a: string, b: string) => `${a}\n${b}`,
  startSignin: async () => undefined,
  cancelSignin: async () => undefined,
  sendSigninCode: async () => true,
});
mockSource('src/components/pages/settings/NewCloudMachineSheet.tsx', {
  NewCloudMachineSheet: (p: { onClose: () => void }) =>
    h('div', { role: 'dialog', 'aria-label': 'New cloud machine' }, h('button', { onClick: p.onClose }, 'Close')),
});
const { HostChip } = await import('../src/components/composer/HostChip.tsx');

const FLEET: HostMachine[] = [
  { id: 'local', name: 'This Mac', status: 'online', note: '' },
  { id: 'cloud:1', name: 'dev-cloud', status: 'offline', note: 'Offline', cloud: { provider: 'oci' } },
  { id: 'cloud:2', name: 'gpu-cloud', status: 'online', note: 'SSH · claude', cloud: { provider: 'oci' } },
];
const titles = () => $$('[role=menu] .menu-title').map((e) => e.textContent);

test('flag on: a Cloud group holds the cloud machines with their lines and dots, then New cloud machine…', async () => {
  on = true;
  lines = new Map<string, unknown>([
    ['cloud:1', { line: 'Asleep · wakes on next message', dot: 'off', action: 'Wake' }],
    ['cloud:2', { line: 'Waking…', dot: 'warn', action: null }],
  ]);
  const m = await mount(h(HostChip, { machines: FLEET }));
  try {
    await click($('button.host-chip'));
    assert.deepEqual(titles(), ['This Mac', 'dev-cloud', 'gpu-cloud', 'New cloud machine…', 'Add machine…', 'Switch host…']);
    assert.equal($('[role=menu] .menu-section-label').textContent, 'Cloud');
    const rows = $$('[role=menu] [role=menuitemradio]');
    assert.equal($('.menu-desc', rows[1]).textContent, 'Asleep · wakes on next message');
    assert.ok($('.host-dot.offline', rows[1]));
    assert.equal($('.menu-desc', rows[2]).textContent, 'Waking…');
    assert.ok($('.host-dot.attention', rows[2]));
    await click($$('[role=menuitem]').find((r) => r.textContent === 'New cloud machine…'));
    assert.equal($('[role=menu]'), null);
    await click($('[role=dialog] button'));
    assert.equal($('[role=dialog]'), null);
  } finally {
    await m.unmount();
  }
});

test('an online cloud machine says how long it may idle after its ordinary line, and a state line replaces it (plan C2)', async () => {
  on = true;
  lines = new Map<string, unknown>([
    ['cloud:1', { line: '', dot: 'off', action: null, idle: 'Stops when idle · 30 min' }],
    ['cloud:2', { line: 'Stopping · idle', dot: 'warn', action: null, idle: 'Stops when idle · 30 min' }],
  ]);
  const m = await mount(h(HostChip, { machines: FLEET }));
  try {
    await click($('button.host-chip'));
    const rows = $$('[role=menu] [role=menuitemradio]');
    assert.equal($('.menu-desc', rows[1]).textContent, 'Offline · Stops when idle · 30 min');
    assert.ok(!$('.host-dot.attention', rows[1]), 'an empty state line leaves the machine’s own dot');
    assert.equal($('.menu-desc', rows[2]).textContent, 'Stopping · idle');
    assert.ok($('.host-dot.attention', rows[2]));
  } finally {
    await m.unmount();
  }
});

test('a cloud machine with no cloud state reads its ordinary line', async () => {
  on = true;
  lines = new Map();
  const m = await mount(h(HostChip, { machines: FLEET }));
  try {
    await click($('button.host-chip'));
    assert.equal($('.menu-desc', $$('[role=menu] [role=menuitemradio]')[1]).textContent, 'Offline');
  } finally {
    await m.unmount();
  }
});

test('flag off: no Cloud group and no New cloud machine…; the machines stay in the one list', async () => {
  on = false;
  const m = await mount(h(HostChip, { machines: FLEET }));
  try {
    await click($('button.host-chip'));
    assert.deepEqual(titles(), ['This Mac', 'dev-cloud', 'gpu-cloud', 'Add machine…', 'Switch host…']);
    assert.equal($('[role=menu] .menu-section-label'), null);
  } finally {
    await m.unmount();
  }
});
