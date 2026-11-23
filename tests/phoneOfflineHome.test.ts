// The home page while the Mac is away keeps its shape (audit gap 1): no banner and no second home, the kept list stays, and the state is the Mac's own (macLink.ts).
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { BY_STATE } from './support/phone/home-layout';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
const appPath = '../mobile/src/MobileApp';
const { MobileApp } = await import(appPath);
const linkPath = '../mobile/src/macLink';
const { awayFromMac, connectingNow } = await import(linkPath);

// a clock the tests move, so nothing that waits a few seconds can hide what the page shows
mock.timers.enable({ apis: ['setTimeout'] });
const reveal = async (ms = 5000) => {
  await act(async () => mock.timers.tick(ms));
  await flush();
};

const online = {
  phase: 'online',
  generation: 1,
  user: { id: 'u' },
  pairs: [
    { pairId: 'p1', macId: 'm1', name: 'Mac one' },
    { pairId: 'p2', macId: 'm2', name: 'Mac two' },
  ],
  selectedPair: 'p2',
  safetyNumber: null,
  pendingPair: false,
  error: null,
  presence: {},
  reconnect: null,
  outbox: [],
};
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

const waitingFor = (pairId: string) => ({ pairId, attempt: 1, nextAt: Date.now() + 5000 });

test('an open chat is kept while the computer is waited for, and is followed again when it returns', async () => {
  const s = scripted((m) => (m === 'chats.recent' ? { chats: [{ id: 'c1', title: 'Fix the build' }] } : undefined), online);
  s.runtime.start = async () => {};
  const listeners = new Set<() => void>();
  s.runtime.subscribe = (f: () => void) => (listeners.add(f), () => listeners.delete(f));
  const change = async (patch: object) => {
    s.state.snap = { ...s.state.snap, ...patch };
    await act(async () => listeners.forEach((f) => f()));
    await flush();
    await reveal();
  };
  const host = await mount(createElement(MobileApp, { runtime: s.runtime, homeLayout: BY_STATE }));
  await click('Open chat');
  assert.ok(s.calls.some(([m, p]) => m === 'chat.follow' && p.chatId === 'c1'));
  const follows = () => s.calls.filter(([m]) => m === 'chat.follow').length;
  const before = follows();
  await change({ phase: 'offline', generation: 2, selectedPair: null, error: 'Computer is offline', reconnect: waitingFor('p2') });
  // the chat keeps its header (its title, the laptop saying the Mac is away) and composer while the computer is away
  assert.ok(host.querySelector('button[aria-label^="Runs on"][aria-label$=", Offline"]'));
  assert.match(host.textContent!, /Fix the build/);
  assert.ok(host.querySelector('input[placeholder="Message this chat"]'));
  await change({ phase: 'online', generation: 3, selectedPair: 'p2', error: null, reconnect: null });
  assert.ok(follows() > before, 'the chat was followed again without a tap');
  assert.match(host.textContent!, /No messages yet\./, 'the chat view is back');
  // leaving the chat while the computer is away goes to the list, and the wait goes on
  await change({ phase: 'offline', generation: 4, selectedPair: null, reconnect: waitingFor('p2') });
  await click('Back to chats');
  assert.match(host.textContent!, /Fix the build/, 'the list kept from before stays, as it was');
  assert.doesNotMatch(host.textContent!, /Mac offline|Reconnect|Your chats, connected to your computer/, 'no banner, no second home');
  assert.doesNotMatch(host.textContent!, /This chat opens again/);
  // a wait that ended (the user disconnected) drops the chat
  await change({ phase: 'online', generation: 5, selectedPair: 'p2', reconnect: null });
  await click('Open chat');
  await change({ phase: 'offline', generation: 6, selectedPair: null, reconnect: null });
  assert.doesNotMatch(host.textContent!, /This chat opens again/);
});

test('the first try the app makes by itself on opening says nothing about a lost connection; after it the Mac counts as away', async () => {
  const first = {
    ...online,
    phase: 'offline',
    selectedPair: null,
    reconnect: { pairId: 'p2', attempt: 0, nextAt: null },
  };
  assert.equal(connectingNow(first), true);
  assert.equal(awayFromMac(first), false);
  assert.equal(awayFromMac({ ...first, reconnect: null }), true);
  assert.equal(awayFromMac({ ...first, reconnect: null, user: null }), false);
  assert.equal(awayFromMac({ ...first, reconnect: null, pairs: [] }), false);
  assert.equal(awayFromMac({ ...first, phase: 'online' }), false);
  assert.equal(connectingNow({ ...first, error: 'Computer is offline' }), false);
  assert.equal(connectingNow({ ...first, reconnect: { pairId: 'p2', attempt: 1, nextAt: Date.now() + 1000 } }), false);
  assert.equal(connectingNow({ ...first, reconnect: { pairId: 'p2', attempt: 0, nextAt: Date.now() + 1000 } }), false);
  assert.equal(connectingNow({ ...first, reconnect: null }), false);
  assert.equal(connectingNow({ ...first, phase: 'online' }), false);
  const s = scripted(() => undefined, first);
  s.runtime.start = async () => {};
  const host = await mount(createElement(MobileApp, { runtime: s.runtime, homeLayout: BY_STATE }));
  await reveal();
  assert.match(host.textContent!, /Connecting to your computer…/);
  assert.doesNotMatch(host.textContent!, /Mac offline|Your computer is offline/);
  assert.doesNotMatch(host.textContent!, /This computer is offline/);
});

test('a paired Mac not connected yet (a pairing just finished) has one Connect on the home page, by name, off while busy', async () => {
  const ready = { ...online, phase: 'ready', selectedPair: null, reconnect: null };
  const s = scripted(() => undefined, ready);
  s.runtime.start = async () => {};
  const connected: string[] = [];
  let release = () => {};
  s.runtime.connect = (pairId: string) => (connected.push(pairId), new Promise<void>((r) => (release = r)));
  const host = await mount(createElement(MobileApp, { runtime: s.runtime, homeLayout: BY_STATE }));
  assert.match(host.textContent!, /Mac onePaired\. Connect to see its chats\./, 'the first paired Mac, by its name');
  assert.doesNotMatch(host.textContent!, /Your chats, connected to your computer/, 'no title over it');
  await click('Connect Mac one');
  assert.deepEqual(connected, ['p1']);
  assert.equal((host.querySelector('button[aria-label="Connect Mac one"]') as HTMLButtonElement).disabled, true, 'off while it connects');
  await act(async () => release());
  const named = scripted(() => undefined, { ...ready, selectedPair: 'p2', pairs: [online.pairs[0], { pairId: 'p2', macId: 'm2' }] });
  named.runtime.start = async () => {};
  const other = await mount(createElement(MobileApp, { runtime: named.runtime, homeLayout: BY_STATE }));
  assert.match(other.textContent!, /ComputerPaired\./, 'the selected one, "Computer" while it has no name');
});

test('while the Mac is away, unsent messages stay on the home page with the line that says when they go', async () => {
  const s = scripted(() => undefined, {
    ...online,
    phase: 'offline',
    selectedPair: null,
    reconnect: null,
    outbox: [{ id: 'q1', chatId: 'c1', text: 'ship it', status: 'queued', at: Date.now() }],
  });
  s.runtime.start = async () => {};
  const host = await mount(createElement(MobileApp, { runtime: s.runtime, homeLayout: BY_STATE }));
  assert.match(host.textContent!, /Unsent messages/);
  assert.match(host.textContent!, /Will send when your computer reconnects\./);
});
