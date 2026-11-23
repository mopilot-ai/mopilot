// Paired computers on the phone: Remove from Settings › Computers goes through the runtime, and a Mac that is away changes no page, only its state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, openComputer } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
const appPath = '../mobile/src/MobileApp';
const { MobileApp } = await import(appPath);

const mounted: any[] = [];
async function mount(node: any) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(node));
  await flush();
  return host;
}

const signedIn = {
  phase: 'offline',
  generation: 1,
  user: { id: 'u' },
  pairs: [{ pairId: 'p1', macId: 'm1', name: 'Studio Mac' }],
  selectedPair: null,
  safetyNumber: null,
  pendingPair: false,
  error: null,
};

test('the app removes the computer through the runtime and shows why when that fails', async () => {
  const s = scripted(() => undefined, signedIn);
  s.runtime.start = async () => {};
  const removed: string[] = [];
  let fail = true;
  s.runtime.unpair = async (pairId: string) => {
    removed.push(pairId);
    if (fail) throw new Error('Secure storage unavailable');
  };
  const host = await mount(createElement(MobileApp, { runtime: s.runtime }));
  await click('Settings');
  await openComputer();
  await click('Remove computer');
  await click('Remove');
  assert.deepEqual(removed, ['p1']);
  assert.match(host.textContent!, /Secure storage unavailable/);
  fail = false;
  await openComputer();
  await click('Remove computer');
  await click('Remove');
  assert.deepEqual(removed, ['p1', 'p1']);
});

test('while the Mac is away the home page keeps its shape: no computer cards or banner, one line when nothing is kept, and the state is on the Settings row', async () => {
  const listeners = new Set<() => void>();
  const s = scripted(() => undefined, {
    ...signedIn,
    pairs: [
      { pairId: 'p1', macId: 'm1', name: 'Studio Mac' },
      { pairId: 'p2', macId: 'm2', name: 'Laptop' },
    ],
    error: 'Relay disconnected',
    presence: { p1: { state: 'sleeping', lastSeen: Date.now() - 2 * 60000 }, p2: { state: 'online', lastSeen: Date.now() } },
  });
  s.runtime.start = async () => {};
  s.runtime.subscribe = (f: () => void) => (listeners.add(f), () => listeners.delete(f));
  const host = await mount(createElement(MobileApp, { runtime: s.runtime }));
  assert.doesNotMatch(
    host.textContent!,
    /Asleep · last seen|Mac offline|Reconnect|offline or asleep/,
    'no cards, no banner, no red reason',
  );
  assert.doesNotMatch(host.textContent!, /Your chats, connected to your computer\./, 'not the waiting page');
  assert.match(host.textContent!, /Your computer is offline\. Your chats show here once it reconnects\./);
  assert.equal(host.querySelector('button[aria-label^="Studio Mac, "]'), null, 'no computer card on the page with nothing kept');
  await click('Settings');
  assert.match(host.textContent!, /Studio MacAsleep/);
  assert.match(host.textContent!, /LaptopAvailable/);
  await click('Close');
  s.state.snap = { ...s.state.snap, phase: 'online', selectedPair: 'p2', error: null };
  await act(async () => listeners.forEach((f) => f()));
  await flush();
  assert.doesNotMatch(host.textContent!, /Your computer is offline/);
  assert.ok(host.querySelector('button[aria-label="Laptop, Connected"]'), 'the computer’s card names the connected computer');
});
