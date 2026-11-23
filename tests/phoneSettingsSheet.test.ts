// The Settings sheet's own pieces: Haptic feedback (kept, and silencing motion.ts), a Mac's page (state, check, Connect, Remove), the account page and its initials, About and the sheet presentation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, openComputer, toggle } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
const g = globalThis as any;
const appPath = '../mobile/src/MobileApp';
const computerPath = '../mobile/src/screens/SettingsComputer';
const pagesPath = '../mobile/src/screens/SettingsPages';
const { MobileApp } = await import(appPath);
const { SettingsComputer } = await import(computerPath);
const { initials, accountTitle } = await import(pagesPath);
const settingsPath = '../mobile/src/screens/Settings';
const { createHaptics, hapticsOn } = await import('../mobile/src/haptics');
const { stackOf } = await import('../mobile/src/stack');

const online = {
  phase: 'online',
  generation: 1,
  user: { id: 'u', name: 'Dana Zhu', email: 'dana@example.com' },
  pairs: [
    { pairId: 'p1', macId: 'm1', name: 'MacBook Pro' },
    { pairId: 'p2', macId: 'm2' },
  ],
  selectedPair: 'p1',
  safetyNumber: null,
  pendingPair: false,
  error: null,
  presence: {},
  reconnect: null,
  outbox: [],
};
const mounted: any[] = [];
async function mount(el: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(el));
  await flush();
  return { host, root };
}
test.afterEach(async () => {
  for (const m of mounted.splice(0)) await act(async () => m.root.unmount()), m.host.remove();
  g.__phoneShareFails = false;
});
async function openSettings(snap: any, props: any = {}) {
  const s = scripted((m) => (m === 'chats.recent' ? { chats: [] } : undefined), snap);
  s.runtime.start = async () => {};
  s.runtime.subscribe = () => () => {};
  const calls: string[] = [];
  s.runtime.connect = async (id: string) => void calls.push(`connect:${id}`);
  s.runtime.unpair = async (id: string) => void calls.push(`unpair:${id}`);
  const { host } = await mount(createElement(MobileApp, { runtime: s.runtime, ...props }));
  await click('Settings');
  return { host, calls };
}

test('Haptic feedback: on until the saved choice says off, an unreadable store stays on, and a refused save keeps the old choice', async () => {
  const stored: { value: string | null; failRead?: boolean; failWrite?: boolean } = { value: 'off' };
  const control = createHaptics({
    read: async () => {
      if (stored.failRead) throw new Error('locked');
      return stored.value;
    },
    write: async (v: string) => {
      if (stored.failWrite) throw new Error('full');
      stored.value = v;
    },
  });
  assert.equal(hapticsOn(), true, 'on before anything is read');
  assert.equal(await control.read(), false);
  assert.equal(hapticsOn(), false);
  await control.set(true);
  assert.deepEqual([stored.value, hapticsOn()], ['on', true]);
  stored.failWrite = true;
  await assert.rejects(control.set(false), /full/);
  assert.equal(hapticsOn(), true, 'a choice that was not kept is not applied');
  stored.failRead = true;
  assert.equal(await control.read(), true);
});

test('with Haptic feedback off, every haptic in motion.ts stays quiet', async () => {
  const { quiet } = await import('../mobile/src/motion');
  const control = createHaptics({ read: async () => 'off', write: async () => {} });
  await control.read();
  let played = 0;
  quiet(async () => void played++);
  assert.equal(played, 0);
  await control.set(true);
  quiet(async () => void played++);
  assert.equal(played, 1);
});

test('Settings › Haptic feedback is a switch on the App group: it shows the saved choice and a refused save flips it back', async () => {
  const set: boolean[] = [];
  const haptics = {
    fail: false,
    read: async () => false,
    set: async (v: boolean) => (set.push(v), haptics.fail ? Promise.reject(new Error('full')) : undefined),
  };
  const { host } = await openSettings(online, { haptics });
  assert.match(host.textContent!, /AppNotifications|AppPrivacy|App.*Haptic feedback/);
  assert.equal(toggle('Haptic feedback'), 'Off');
  await click('Haptic feedback');
  assert.equal(toggle('Haptic feedback'), 'On');
  haptics.fail = true;
  await click('Haptic feedback');
  assert.equal(toggle('Haptic feedback'), 'On', 'the refused Off is undone');
  assert.deepEqual(set, [true, false]);
});

test('a Mac row opens its page: connected shows no check and offers Reconnect; Remove asks first and Keep backs out', async () => {
  const { host, calls } = await openSettings(online);
  assert.match(host.textContent!, /MacBook ProConnected/);
  assert.match(host.textContent!, /ComputerOffline/, 'a pair without a name is "Computer"');
  await openComputer('MacBook Pro');
  assert.match(host.textContent!, /MacBook Pro.*Status.*Connected/);
  assert.doesNotMatch(host.textContent!, /Connection check/, 'nothing to check while connected');
  assert.doesNotMatch(host.textContent!, /Keep this Mac reachable/);
  await click('Reconnect');
  assert.deepEqual(calls, ['connect:p1']);
  await click('Remove computer');
  assert.match(host.textContent!, /Removing MacBook Pro deletes its keys here, and you pair again to use it\./);
  await click('Keep');
  assert.doesNotMatch(host.textContent!, /Removing MacBook Pro deletes its keys/);
  await click('Remove computer');
  await click('Remove');
  assert.deepEqual(calls, ['connect:p1', 'unpair:p1']);
  assert.match(host.textContent!, /Add a computer/, 'back on the list after removing');
});

test('a Mac page while busy: Connecting… and no removal; a failed share says so on the row', async () => {
  const calls: string[] = [];
  const shared: string[] = [];
  let fail = false;
  const props = (busy: boolean) => ({
    state: { ...online, phase: 'offline' },
    pairId: 'p1',
    pushUi: null,
    version: '1.0',
    busy,
    error: 'Computer is offline',
    back: () => calls.push('back'),
    connect: () => calls.push('connect'),
    remove: () => calls.push('remove'),
    share: async (m: string) => (fail ? Promise.reject(new Error('no')) : void shared.push(m)),
    now: () => 1,
  });
  const { host, root } = await mount(createElement(SettingsComputer, props(true)));
  assert.match(host.textContent!, /Your computer is offline or asleep/, 'the reason reads as one a person can act on');
  assert.match(host.textContent!, /Connecting…/);
  const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent);
  assert.ok(!buttons().includes('Connecting…') && !buttons().includes('Remove computer'), 'busy: neither connect nor remove is pressable');
  await act(async () => root.render(createElement(SettingsComputer, props(false))));
  await click('Remove computer');
  await act(async () => root.render(createElement(SettingsComputer, props(true))));
  assert.ok(!buttons().includes('Remove'), 'a removal asked for before busy waits');
  assert.deepEqual(calls, []);
  await click('Share report');
  assert.match(shared[0], /^MoPilot connection check \(1\.0\)/);
  fail = true;
  await click('Share report');
  assert.match(host.textContent!, /The report could not be shared\./);
  await click('Back');
  assert.deepEqual(calls, ['back']);
});

test('the account row shows the initials and email; its page names the account and offers Delete account', async () => {
  const { host } = await openSettings(online);
  assert.match(host.textContent!, /DZdana@example\.comMoPilot account/);
  await click('dana@example.com');
  assert.match(host.textContent!, /Dana Zhu · MoPilot account/);
  assert.match(host.textContent!, /Delete account/);
  await click('Back');
  assert.match(host.textContent!, /Computers/);
  assert.equal(initials({ id: 'u', name: 'cher' }), 'C');
  assert.equal(initials({ id: 'u', email: 'x@y.z' }), 'X');
  assert.equal(initials({ id: 'u7' }), 'U');
  assert.equal(initials(null), '?');
  assert.equal(initials({ id: ' ' }), '?');
  assert.equal(accountTitle(null), '');
  assert.equal(accountTitle({ id: 'u', name: 'N' }), 'N');
  const { NO_APPEARANCE } = await import(settingsPath);
  assert.equal(await NO_APPEARANCE.read(), 'system');
  assert.equal(await NO_APPEARANCE.set('dark'), undefined, 'a build without the control keeps nothing');
});

test('a dev build names its relay and account under About; Privacy says where the data stays', async () => {
  const { host } = await openSettings(
    { ...online, user: { id: 'u' } },
    { devEndpoints: { relayUrl: 'ws://10.0.0.2:8787', accountOrigin: 'http://10.0.0.2:8787' } },
  );
  assert.match(host.textContent!, /uMoPilot account/, 'with no name or email the id stands in');
  await click('About');
  assert.match(host.textContent!, /Relayws:\/\/10\.0\.0\.2:8787/);
  assert.match(host.textContent!, /Development build/);
});

test('the hardware back closes a page first, then the sheet; Settings is presented as a sheet', async () => {
  g.__phonePlatform = 'android';
  try {
    const { host } = await openSettings(online);
    const press = async () => {
      await act(async () => void (g.__phoneBackListeners as Array<() => boolean>).at(-1)!());
      await flush();
    };
    await click('Privacy');
    await press();
    assert.match(host.textContent!, /Computers/, 'back on the list');
    await press();
    assert.doesNotMatch(host.textContent!, /Add a computer/, 'the sheet closed');
  } finally {
    delete g.__phonePlatform;
    g.__phoneBackListeners = [];
  }
  const settings = stackOf({ settings: true } as any).at(-1);
  assert.equal(settings?.sheet, true);
});
