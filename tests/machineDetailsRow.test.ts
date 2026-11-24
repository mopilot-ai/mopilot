// A machine's Details (src/components/pages/settings/MachineDetails.tsx) from its ⋯ menu: the dialog names the machine and what it is told of it, and closes with Escape; an offline machine says so.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, resetCtl, responses, useStore, defaultState, render, click, button, text, flush, key } from './support/settings-harness.ts';

await setup();
await import('../src/lib/native/host.ts');
const { createElement: h } = await import('react');
const { HostMachines } = await import('../src/components/pages/settings/HostMachines.tsx');

const MINI = {
  id: 'ssh:mini',
  name: 'mini',
  status: 'online',
  note: 'SSH · Claude Code',
  signin: null,
  capabilities: { iab: false, cu: false },
  agents: [{ id: 'claude', label: 'Claude Code', state: 'ready', reason: '' }],
};

beforeEach(() => {
  resetCtl();
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  Object.assign(responses, {
    'host.access': true,
    'host.onAccess': () => () => undefined,
    'host.machines': () => Promise.resolve({ machines: [MINI], resolved: true }),
    'host.onMachines': () => () => undefined,
    'host.onInstallStep': () => () => undefined,
    'host.onSignin': () => () => undefined,
  });
});

test('Details opens from the ⋯ menu: the machine’s name, how it is reached, its system, its Host’s version and when it last answered; Escape closes it', async (t) => {
  responses['host.machines'] = () =>
    Promise.resolve({ machines: [{ ...MINI, address: 'me@mini', hostVersion: '1.4.0', platform: 'darwin' }], resolved: true });
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  await click(button(root.host, 'More for mini'));
  await click(button(root.host, 'Details'));
  const dialog = root.host.querySelector('.dialog')!;
  assert.match(text(dialog), /mini/);
  assert.match(text(dialog), /Connected/);
  for (const [label, value] of [
    ['Host', 'me@mini'],
    ['System', 'macOS'],
    ['Version', '1.4.0'],
    ['Last seen', 'Just now'],
  ]) {
    assert.match(text(dialog), new RegExp(`${label}${value}`));
  }
  await key(dialog, { key: 'Escape' });
  assert.equal(root.host.querySelector('.dialog'), null);
});

test('Details of an offline machine says Offline', async (t) => {
  responses['host.machines'] = () => Promise.resolve({ machines: [{ ...MINI, status: 'offline', lastSeen: 1_000 }], resolved: true });
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  await click(button(root.host, 'More for mini'));
  await click(button(root.host, 'Details'));
  assert.match(text(root.host.querySelector('.dialog')!), /Offline/);
});
