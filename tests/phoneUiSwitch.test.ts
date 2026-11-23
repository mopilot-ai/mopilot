// The Phone UI switch in Settings › About: Classic or New through the flag, said to apply the next launch, and the version line names the UI drawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';

// variable specifiers keep React Native's global typings out of the repository-wide typecheck
const appPath = '../mobile/src/MobileApp';
const flagPath = '../mobile/src/ui/flag';
const { MobileApp } = await import(appPath);
const { createPhoneUiFlag, phoneUiChoice, v2Id } = await import(flagPath);

const online = {
  phase: 'online',
  generation: 1,
  user: { id: 'u', name: 'Dana Zhu', email: 'dana@example.com' },
  pairs: [{ pairId: 'p1', macId: 'm1', name: 'MacBook Pro' }],
  selectedPair: 'p1',
  safetyNumber: null,
  pendingPair: false,
  error: null,
  presence: {},
  reconnect: null,
  outbox: [],
};
const mounted: any[] = [];
test.afterEach(async () => {
  for (const m of mounted.splice(0)) await act(async () => m.root.unmount()), m.host.remove();
});
const store = (initial: string | null = null, fail = false) => {
  const state = { value: initial };
  return {
    state,
    read: async () => state.value,
    write: async (next: string | null) => {
      if (fail) throw new Error('keychain locked');
      state.value = next;
    },
  };
};
async function openAbout(phoneUi: any, version = '1.0.0 (12)') {
  const s = scripted((m) => (m === 'chats.recent' ? { chats: [] } : undefined), online);
  s.runtime.start = async () => {};
  s.runtime.subscribe = () => () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime, phoneUi, version })));
  await flush();
  await click('Settings');
  await click('About');
  return host;
}

test('the choice shows the build default as picked, and the version line names the UI drawn', async () => {
  const flag = createPhoneUiFlag(store(), 'classic');
  const host = await openAbout(flag);
  assert.match(host.textContent!, /Version 1\.0\.0 \(12\) · Classic UI/);
  assert.match(host.textContent!, /Phone UI/);
  assert.equal(host.querySelector('button[aria-label="Classic"]')?.getAttribute('aria-selected'), 'true');
  assert.doesNotMatch(host.textContent!, /next time you open/);
});

test('choosing New saves it, says it applies the next launch, and this launch keeps drawing the same UI', async () => {
  const kept = store();
  const flag = createPhoneUiFlag(kept, 'classic');
  const host = await openAbout(flag);
  await click('New');
  assert.equal(kept.state.value, 'v2');
  assert.match(host.textContent!, /Takes effect the next time you open MoPilot/);
  assert.equal(host.querySelector('button[aria-label="New"]')?.getAttribute('aria-selected'), 'true');
  assert.match(host.textContent!, /· Classic UI/, 'this launch still draws classic');
  assert.equal(flag.get(), 'classic');
});

test('a saved New applies on the next launch: the line says New UI and nothing is pending', async () => {
  const flag = createPhoneUiFlag(store('v2'), 'classic');
  await flag.load();
  const host = await openAbout(flag);
  assert.match(host.textContent!, /· New UI/);
  assert.doesNotMatch(host.textContent!, /next time you open/);
  await click('Classic');
  assert.match(host.textContent!, /next time you open/);
});

test('a choice the keychain refuses is put back', async () => {
  const flag = createPhoneUiFlag(store(null, true), 'classic');
  const host = await openAbout(flag);
  await click('New');
  await flush();
  assert.equal(host.querySelector('button[aria-label="Classic"]')?.getAttribute('aria-selected'), 'true');
  assert.doesNotMatch(host.textContent!, /next time you open/);
});

test('a build without the control draws About as before, with no Phone UI row', async () => {
  const host = await openAbout(undefined);
  assert.match(host.textContent!, /Version 1\.0\.0 \(12\)/);
  assert.doesNotMatch(host.textContent!, /Classic UI|New UI|Phone UI/);
});

test('phoneUiChoice picks the saved one else the active one, and pending only when they differ', () => {
  assert.deepEqual(phoneUiChoice('classic', null), { picked: 'classic', pending: false });
  assert.deepEqual(phoneUiChoice('classic', 'v2'), { picked: 'v2', pending: true });
  assert.deepEqual(phoneUiChoice('v2', 'v2'), { picked: 'v2', pending: false });
});

test('v2Id names a screen root so a device test can find it', () => {
  assert.equal(v2Id('thread'), 'thread-v2');
  assert.equal(v2Id('composer'), 'composer-v2');
});

test('About says whether chats on machines are on and why, in words, and draws no row for a phone without paths of its own', async () => {
  const pagePath = '../mobile/src/screens/SettingsPages';
  const { AboutPage } = await import(pagePath);
  const draw = async (machineChats?: { on: boolean; why: string }) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(AboutPage, { version: '1.0.0', machineChats, back: () => undefined })));
    const text = host.textContent!;
    await act(async () => root.unmount());
    host.remove();
    return text;
  };
  assert.match(await draw({ on: true, why: 'build' }), /Chats on machinesOn · this build/);
  assert.match(await draw({ on: true, why: 'mac' }), /On · your Mac/);
  assert.match(await draw({ on: true, why: 'saved' }), /On · set on this phone/);
  assert.match(await draw({ on: true, why: 'other' }), /On · other/);
  assert.match(await draw({ on: false, why: 'off' }), /Chats on machinesOff/);
  assert.doesNotMatch(await draw(undefined), /Chats on machines/);
});
