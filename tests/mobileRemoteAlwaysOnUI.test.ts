// Settings → Connections → Keep this Mac reachable (src/components/pages/settings/MobileRemoteAlwaysOn.tsx): shown only while Mobile Remote is on, three switches off by default, the login switch needing the menu-bar one, a failed save told and the switch left where it was. Main is the settings harness's fake native.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, calls, responses, resetCtl, defaultState, useStore, render, text, row, flush, toggle } from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { Settings } = await import('../src/components/pages/Settings.tsx');
await import('../src/lib/native/alwaysOn.ts');

const state = (o: any = {}) => ({
  prefs: { keepRunning: false, loginItem: false, preventSleep: false },
  remoteOn: true,
  active: false,
  paired: 0,
  connected: false,
  loginItemSupported: true,
  ...o,
});
let changed: ((s: any) => void) | null = null;
const of = (name: string) => calls.filter((c) => c[0] === `alwaysOn.${name}`).map((c) => c.slice(1));
const page = async () => {
  useStore.setState({ route: { name: 'settings' } });
  const v = await render(h(Settings, { section: 'connections' }));
  await flush();
  return v;
};

beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
  changed = null;
  responses['alwaysOn.get'] = Promise.resolve(state());
  responses['alwaysOn.set'] = (patch: any) => Promise.resolve(state({ prefs: { ...state().prefs, ...patch } }));
  responses['alwaysOn.onChanged'] = (cb: (s: any) => void) => ((changed = cb), () => {});
});

test('nothing is offered while Mobile Remote is off or the state cannot be read', async () => {
  responses['alwaysOn.get'] = Promise.resolve(state({ remoteOn: false }));
  let v = await page();
  assert.doesNotMatch(text(v.host), /Keep this Mac reachable/);
  await v.unmount();
  responses['alwaysOn.get'] = () => Promise.reject(new Error('main is not ready'));
  v = await page();
  assert.doesNotMatch(text(v.host), /Keep this Mac reachable/);
  await v.unmount();
});

test('three switches, off by default; the login switch waits for the menu-bar one; each writes through main', async () => {
  const v = await page();
  const root = v.host;
  assert.match(text(root), /Keep this Mac reachable/);
  assert.equal(row(root, 'Start at login').querySelector('[role=switch]')!.hasAttribute('disabled'), true);
  await toggle(root, 'Keep running in the menu bar');
  await toggle(root, 'Stay awake when plugged in');
  assert.deepEqual(of('set'), [[{ keepRunning: true }], [{ preventSleep: true }]]);
  // main's answer is the state shown, and a change made in another window arrives the same way
  changed!(state({ prefs: { keepRunning: true, loginItem: false, preventSleep: true } }));
  await flush();
  assert.equal(row(root, 'Start at login').querySelector('[role=switch]')!.hasAttribute('disabled'), false);
  await toggle(root, 'Start at login');
  assert.deepEqual(of('set').at(-1), [{ loginItem: true }]);
  await v.unmount();
});

test('no login switch where the system has no login item; a save that fails is told', async () => {
  responses['alwaysOn.get'] = Promise.resolve(state({ loginItemSupported: false }));
  const v = await page();
  assert.doesNotMatch(text(v.host), /Start at login/);
  responses['alwaysOn.set'] = () => Promise.reject(new Error("Couldn't save the setting: disk full"));
  await toggle(v.host, 'Keep running in the menu bar');
  await flush();
  assert.ok(calls.some((c) => c[0] === 'toast' && /Couldn't change the menu bar setting/.test(String(c[1]))));
  await v.unmount();
});

test('the group sits directly under the Phone section, before the other connection groups', async () => {
  responses['remoteSettings.state'] = { visible: true, signedIn: true, enabled: true, running: true, pairing: null, devices: [] };
  responses['remoteSettings.cancel'] = true;
  const v = await page();
  const titles = [...v.host.querySelectorAll('.settings-group-title')].map((t) => text(t));
  const at = titles.indexOf('Phone');
  assert.ok(at >= 0, 'the Phone section is shown');
  assert.equal(titles[at + 1], 'Keep this Mac reachable');
  await v.unmount();
});
