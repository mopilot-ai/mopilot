// Settings › Connections by direction (ConnectionsTabs.tsx): Control this Mac, Control other devices and SSH, each one page; the tab is the route's own, a missing or unknown one is the first, and the machines tab is offered only where Host is.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  resetCtl,
  responses,
  calls,
  useStore,
  defaultState,
  render,
  click,
  button,
  text,
  flush,
  key,
} from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { Settings } = await import('../src/components/pages/Settings.tsx');
const { connectionsRoute } = await import('../src/lib/connectionsRoute.ts');

beforeEach(() => {
  resetCtl();
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  Object.assign(responses, {
    'host.access': true,
    'host.onAccess': () => () => undefined,
    'host.machines': () => Promise.resolve({ machines: [], resolved: true }),
    'host.onMachines': () => () => undefined,
    'host.onInstallStep': () => () => undefined,
    'host.onSignin': () => () => undefined,
    'remoteSettings.state': { visible: true, signedIn: true, enabled: false, running: false, pairing: null, devices: [] },
  });
});

const tabs = (root: Element) =>
  [...root.querySelectorAll('[role=tab]')].map((t) => `${text(t)}${t.getAttribute('aria-selected') === 'true' ? '*' : ''}`);
const titles = (root: Element) => [...root.querySelectorAll('.settings-group-title')].map((t) => text(t));

async function open(tab?: string) {
  useStore.setState({ route: { name: 'settings', section: 'connections', ...(tab ? { tab } : {}) } } as any);
  const view = await render(h(Settings, { section: 'connections' }));
  await flush(3);
  return view;
}

test('no tab opens Control this Mac: the phone group, not the machines or the ssh list', async (t) => {
  const view = await open();
  t.after(() => view.unmount());
  assert.deepEqual(tabs(view.host), ['Control this Mac*', 'Control other devices', 'SSH']);
  assert.ok(titles(view.host).includes('Devices that can control this Mac'));
  assert.ok(!titles(view.host).includes('Machines'));
  assert.ok(!titles(view.host).includes('SSH connections from this Mac'));
});

test('each tab shows its own page, and a tab button moves the route', async (t) => {
  const view = await open('other');
  t.after(() => view.unmount());
  assert.deepEqual(tabs(view.host), ['Control this Mac', 'Control other devices*', 'SSH']);
  assert.ok(titles(view.host).includes('Machines'));
  assert.ok(!titles(view.host).includes('Devices that can control this Mac'));
  await click(button(view.host, 'SSH'));
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'settings', section: 'connections', tab: 'ssh' }]);
  assert.deepEqual(connectionsRoute('ssh'), { name: 'settings', section: 'connections', tab: 'ssh' });
});

test('an unknown tab is the first', async (t) => {
  const view = await open('nope');
  t.after(() => view.unmount());
  assert.deepEqual(tabs(view.host), ['Control this Mac*', 'Control other devices', 'SSH']);
});

test('Control this Mac: the switch, the phones and the header Add are one list; Other settings follows with Keep this Mac awake', async (t) => {
  Object.assign(responses, {
    'remoteSettings.state': {
      visible: true,
      signedIn: true,
      enabled: true,
      running: true,
      locked: false,
      pairing: null,
      devices: [
        {
          id: 'a',
          pairId: 'pa',
          name: 'iPhone',
          lastSeenAt: null,
          pairedAt: 1_700_000_000_000,
          online: true,
          connection: 'connected',
          mirrors: false,
          retired: false,
        },
      ],
    },
    'alwaysOn.get': Promise.resolve({
      prefs: { keepRunning: false, loginItem: false, preventSleep: false },
      remoteOn: true,
      active: false,
      paired: 1,
      connected: true,
      loginItemSupported: true,
    }),
    'alwaysOn.onChanged': () => () => undefined,
  });
  const view = await open();
  t.after(() => view.unmount());
  assert.deepEqual(titles(view.host), ['Devices that can control this Mac', 'Other settings']);
  const first = view.host.querySelector('.settings-group')!;
  assert.equal(first.querySelector('[role=switch][aria-label="Allow connections"]')?.getAttribute('aria-checked'), 'true');
  assert.ok(button(first, 'Add') && button(first, 'Refresh') && button(first, 'Revoke access'));
  assert.ok(text(view.host.querySelectorAll('.settings-group')[1]).startsWith('Other settingsKeep this Mac awake'));
});

test('Allow connections off asks first and says what it does to live sessions; turning it off cancels nothing until confirmed', async (t) => {
  Object.assign(responses, {
    'remoteSettings.state': { visible: true, signedIn: true, enabled: true, running: true, locked: false, pairing: null, devices: [] },
    'remoteSettings.setEnabled': true,
  });
  const view = await open();
  t.after(() => view.unmount());
  await click(view.host.querySelector('[role=switch][aria-label="Allow connections"]')!);
  const ask = view.host.querySelector('[role=alertdialog]')!;
  assert.match(text(ask), /Turn off connections\?/);
  assert.match(text(ask), /connected now are disconnected/);
  assert.equal(
    calls.some((c) => c[0] === 'remoteSettings.setEnabled'),
    false,
    'nothing changed yet',
  );
  await click(button(ask, 'Cancel'));
  assert.equal(view.host.querySelector('[role=alertdialog]'), null);
  await click(view.host.querySelector('[role=switch][aria-label="Allow connections"]')!);
  await click(button(view.host.querySelector('[role=alertdialog]')!, 'Turn off'));
  assert.deepEqual(calls.filter((c) => c[0] === 'remoteSettings.setEnabled').at(-1), ['remoteSettings.setEnabled', false]);
});

test('revoking a phone names it and says what happens, then revokes by its own pair', async (t) => {
  Object.assign(responses, {
    'remoteSettings.state': {
      visible: true,
      signedIn: true,
      enabled: true,
      running: true,
      locked: false,
      pairing: null,
      devices: [
        {
          id: 'a',
          pairId: 'pa',
          name: 'iPhone',
          lastSeenAt: null,
          pairedAt: 1,
          online: true,
          connection: 'connected',
          mirrors: false,
          retired: false,
        },
      ],
    },
    'remoteSettings.revoke': true,
  });
  const view = await open();
  t.after(() => view.unmount());
  await click(button(view.host, 'Revoke access for iPhone'));
  assert.match(text(view.host.querySelector('[role=alertdialog]')!), /must be paired again to control this Mac/);
  // Escape answers no
  await key(view.host.querySelector('.sketch-backdrop')!, { key: 'Escape' });
  assert.equal(view.host.querySelector('[role=alertdialog]'), null);
  await click(button(view.host, 'Revoke access for iPhone'));
  await click(button(view.host.querySelector('[role=alertdialog]')!, 'Revoke access'));
  assert.deepEqual(calls.filter((c) => c[0] === 'remoteSettings.revoke').at(-1), ['remoteSettings.revoke', 'a', 'pa']);
});
