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
mocks[url('harness/adapters/codexApi.ts')] = {
  codexApi: {
    remoteControlRead: async () => off,
    remoteControlSet: async (on: boolean) => {
      computerSets.push(on);
      return { ...off, status: on ? 'connecting' : 'disabled' };
    },
  },
};
const { createElement: h } = await import('react');
const { Settings } = await import('../src/components/pages/Settings.tsx');

beforeEach(() => {
  resetCtl();
  computerSets.length = 0;
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  responses['remoteSettings.cancel'] = true;
});

test('computer control remains reachable when Mobile Remote is hidden and keeps its own consent', async (t) => {
  responses['remoteSettings.state'] = { visible: false };
  const view = await render(h(Settings, { section: 'connections' }));
  t.after(() => view.unmount());
  assert.match(text(view.host), /Control from ChatGPT/);
  assert.doesNotMatch(text(view.host), /Allow phone access/);
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
    assert.match(text(view.host), /Control from ChatGPT/);
    const titles = [...view.host.querySelectorAll('.settings-group-title')].map((title) => text(title));
    assert.equal(titles[0], 'Phone', 'the phone comes first');
    await toggle(view.host, 'Allow phone access');
    await flush(50);
    const groups = [...view.host.querySelectorAll('.settings-group')];
    const computer = groups.find((group) => text(group.querySelector('.settings-group-title')) === 'Control from ChatGPT')!;
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
