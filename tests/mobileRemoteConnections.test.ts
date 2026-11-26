// Connections keeps the independent computer-control and Mobile Remote entries, consent and failures.
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
  toggle,
  click,
  button,
  text,
  flush,
} from './support/settings-harness.ts';

await setup();
const mocks = (globalThis as any).__settingsMocks;
const url = (path: string) => new URL(`../src/${path}`, import.meta.url).href;
delete mocks[url('components/pages/settings/RemoteControl.tsx')];
mocks[url('store/chats.ts')].codexUsable = () => true;
const computerSets: boolean[] = [];
const off = { status: 'disabled', environmentId: null, error: null };
let codexNow: any = off;
let codexRefuses = false;
mocks[url('harness/adapters/codexApi.ts')] = {
  codexApi: {
    remoteControlRead: async () => codexNow,
    remoteControlClients: async () => [],
    remoteControlSet: async (on: boolean) => {
      computerSets.push(on);
      if (codexRefuses) throw new Error('ChatGPT would not turn it off');
      return { ...off, status: on ? 'connecting' : 'disabled' };
    },
  },
};
const { closeConnectPhone, isConnectPhoneOpen } = await import('../src/lib/phoneEntry.ts');
const { createElement: h } = await import('react');
const { Settings } = await import('../src/components/pages/Settings.tsx');

beforeEach(() => {
  resetCtl();
  computerSets.length = 0;
  codexNow = off;
  codexRefuses = false;
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  responses['remoteSettings.cancel'] = true;
});

test('computer control remains reachable when Mobile Remote is hidden and keeps its own consent', async (t) => {
  responses['remoteSettings.state'] = { visible: false };
  const view = await render(h(Settings, { section: 'connections' }));
  t.after(() => view.unmount());
  assert.match(text(view.host), /Allow this computer to be controlled/);
  assert.doesNotMatch(text(view.host), /Allow connections/);
  await toggle(view.host, 'Allow this computer to be controlled');
  const dialog = view.host.querySelector('[role=alertdialog]')!;
  assert.ok(dialog);
  assert.deepEqual(computerSets, []);
  await click(button(dialog, 'Allow'));
  assert.deepEqual(computerSets, [true]);
  assert.equal(
    calls.some(([name]) => name === 'remoteSettings.setEnabled'),
    false,
  );
});

test('the phone opt-in leaves computer control unchanged, and leaving the page ends no pairing', async () => {
  let state = { visible: true, signedIn: true, enabled: false, running: false, pairing: null, devices: [] };
  responses['remoteSettings.state'] = () => state;
  responses['remoteSettings.setEnabled'] = (on: boolean) => {
    state = { ...state, enabled: on, running: on };
    return true;
  };
  const view = await render(h(Settings, { section: 'connections' }));
  try {
    assert.match(text(view.host), /Allow this computer to be controlled/);
    const titles = [...view.host.querySelectorAll('.settings-group-title')].map((title) => text(title));
    assert.equal(titles[0], 'Devices that can control this Mac', 'the devices come first');
    await toggle(view.host, 'Allow connections');
    await flush(50);
    const groups = [...view.host.querySelectorAll('.settings-group')];
    const computer = groups.find((group) => text(group.querySelector('.settings-group-title')) === 'Other settings')!;
    assert.equal(computer.querySelector('[role=switch]')!.getAttribute('aria-checked'), 'false');
    assert.deepEqual(computerSets, []);
    assert.deepEqual(
      calls.find(([name]) => name === 'remoteSettings.setEnabled'),
      ['remoteSettings.setEnabled', true],
    );
    await view.rerender(h(Settings, { section: 'general' }));
    assert.equal(calls.filter(([name]) => name === 'remoteSettings.cancel').length, 0);
  } finally {
    await view.unmount();
  }
});

const phoneState = (o: object = {}) => ({ visible: true, signedIn: true, enabled: true, running: true, pairing: null, devices: [], ...o });
const setEnabledCalls = () => calls.filter(([name]) => name === 'remoteSettings.setEnabled').map((c) => c[1]);

test('Allow connections off with a ChatGPT device linked: asks first, then turns the phones and the ChatGPT link off', async (t) => {
  codexNow = { status: 'connected', environmentId: 'env', error: null };
  responses['remoteSettings.state'] = phoneState();
  responses['remoteSettings.setEnabled'] = true;
  const view = await render(h(Settings, { section: 'connections' }));
  t.after(() => view.unmount());
  await flush(50);
  await toggle(view.host, 'Allow connections');
  assert.match(text(view.host.querySelector('[role=alertdialog]')!), /Phones and other devices connected now are disconnected/);
  assert.deepEqual([setEnabledCalls(), computerSets], [[], []], 'nothing changes before the answer');
  await click(button(view.host.querySelector('[role=alertdialog]')!, 'Turn off'));
  await flush(50);
  assert.deepEqual([setEnabledCalls(), computerSets], [[false], [false]]);
});

test('a change that gets halfway says why and leaves the switch on, so it can be tried again', async (t) => {
  codexNow = { status: 'connected', environmentId: 'env', error: null };
  codexRefuses = true;
  let enabled = true;
  responses['remoteSettings.state'] = () => phoneState({ enabled });
  responses['remoteSettings.setEnabled'] = (on: boolean) => ((enabled = on), true);
  const view = await render(h(Settings, { section: 'connections' }));
  t.after(() => view.unmount());
  await flush(50);
  await toggle(view.host, 'Allow connections');
  await click(button(view.host.querySelector('[role=alertdialog]')!, 'Turn off'));
  await flush(50);
  assert.deepEqual(setEnabledCalls(), [false], 'the phones went off');
  // the link's own refusal is told in its toast (setCodexRemoteControl), with its cause
  assert.ok(
    calls.some(
      ([name, message]) => name === 'toast' && /Couldn't turn off Remote Control: .*ChatGPT would not turn it off/.test(String(message)),
    ),
    'the cause is told',
  );
  const master = view.host.querySelector('[role=switch][aria-label="Allow connections"]')!;
  assert.equal(master.getAttribute('aria-checked'), 'true', 'still on: the ChatGPT link is');
  await toggle(view.host, 'Allow connections');
  assert.ok(view.host.querySelector('[role=alertdialog]'), 'the same switch asks again');
});

test('turning Allow connections on turns the phones on and leaves ChatGPT’s link alone', async (t) => {
  responses['remoteSettings.state'] = phoneState({ enabled: false, running: false });
  responses['remoteSettings.setEnabled'] = true;
  const view = await render(h(Settings, { section: 'connections' }));
  t.after(() => view.unmount());
  await flush(50);
  await toggle(view.host, 'Allow connections');
  await flush(50);
  assert.deepEqual([setEnabledCalls(), computerSets], [[true], []]);
});

test('signed out of MoPilot: Allow connections cannot be used, and ChatGPT’s own switch still can (no lock)', async (t) => {
  responses['remoteSettings.state'] = phoneState({ signedIn: false, enabled: false, running: false });
  const view = await render(h(Settings, { section: 'connections' }));
  t.after(() => view.unmount());
  await flush(50);
  assert.equal(view.host.querySelector('[role=switch][aria-label="Allow connections"]')!.hasAttribute('disabled'), true);
  assert.equal(
    view.host.querySelector('[role=switch][aria-label="Allow this computer to be controlled"]')!.hasAttribute('disabled'),
    false,
  );
});

test('with the ChatGPT link up and the phones off, Add turns the phones on and opens the pairing dialog; the link stays up', async (t) => {
  codexNow = { status: 'connected', environmentId: 'env', error: null };
  let enabled = false;
  responses['remoteSettings.state'] = () => phoneState({ enabled, running: enabled });
  responses['remoteSettings.setEnabled'] = (on: boolean) => ((enabled = on), true);
  const view = await render(h(Settings, { section: 'connections' }));
  t.after(() => view.unmount());
  await flush(50);
  await click(button(view.host, 'Add'));
  await flush(50);
  assert.deepEqual([setEnabledCalls(), computerSets], [[true], []], 'phones on, nothing torn down');
  assert.equal(isConnectPhoneOpen(), true, 'the pairing dialog opens when the phones came on');
  closeConnectPhone();
});

test('Add with a refused change does not open the pairing dialog; the refusal is the one thing shown', async (t) => {
  codexNow = { status: 'connected', environmentId: 'env', error: null };
  responses['remoteSettings.state'] = () => phoneState({ enabled: false, running: false });
  responses['remoteSettings.setEnabled'] = () => Promise.reject(new Error('Could not turn phones on'));
  const view = await render(h(Settings, { section: 'connections' }));
  t.after(() => view.unmount());
  await flush(50);
  await click(button(view.host, 'Add'));
  await flush(50);
  assert.equal(isConnectPhoneOpen(), false);
  assert.match(text(view.host), /Could not turn phones on/);
});

test('signed out with ChatGPT usable, the description says the other switch still works; the ChatGPT rows stay when the phone state cannot be read', async (t) => {
  responses['remoteSettings.state'] = phoneState({ signedIn: false, enabled: false, running: false });
  const signedOut = await render(h(Settings, { section: 'connections' }));
  await flush(50);
  assert.match(text(signedOut.host), /Other devices have their own switch under Other settings/);
  await signedOut.unmount();
  codexNow = { status: 'connected', environmentId: 'env', error: null };
  responses['remoteSettings.state'] = () => Promise.reject(new Error('Status unavailable'));
  const broken = await render(h(Settings, { section: 'connections' }));
  t.after(() => broken.unmount());
  await flush(50);
  assert.match(text(broken.host), /Status unavailable/);
  assert.match(text(broken.host), /No devices added yet/);
});
