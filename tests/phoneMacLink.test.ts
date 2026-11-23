// The Mac link every phone screen reads (mobile/src/macLink.ts): Connected only while the phone is online to it and the relay has not said it left; the chip, row word and offline lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
const linkPath = '../mobile/src/macLink';
const linkModule = await import(linkPath);
const { macLink, macState, MacLinkProvider, useMacLink, QUEUED_LINE, APPROVAL_OFFLINE_LINE, MAC_WORD } = linkModule;

const base = {
  phase: 'online',
  generation: 1,
  user: { id: 'u' },
  pairs: [
    { pairId: 'p1', macId: 'm1', name: 'MacBook Pro' },
    { pairId: 'p2', macId: 'm2' },
  ],
  selectedPair: 'p1',
  safetyNumber: null,
  pendingPair: false,
  pairCleanup: false,
  error: null,
  presence: {},
  reconnect: null,
  outbox: [],
};

test('the selected Mac is connected while the phone is online to it, and offline the moment the relay says it slept or left', () => {
  assert.deepEqual(macLink(base), {
    pairId: 'p1',
    name: 'MacBook Pro',
    state: 'connected',
    online: true,
    chip: 'MacBook Pro',
    word: 'Connected',
  });
  for (const presence of ['sleeping', 'gone']) {
    const link = macLink({ ...base, presence: { p1: { state: presence, lastSeen: 1 } } });
    assert.equal(link.state, 'offline');
    assert.equal(link.online, false);
    assert.equal(link.chip, 'MacBook Pro · Offline', 'the real name stays, only the state is added');
    assert.equal(link.word, presence === 'sleeping' ? 'Asleep' : 'Offline');
  }
  assert.equal(macLink({ ...base, presence: { p1: { state: 'online', lastSeen: 1 } } }).online, true);
});

test('without a connection the Mac is offline, whatever the relay last said; another paired Mac the relay sees is available', () => {
  const offline = { ...base, phase: 'offline', presence: { p1: { state: 'online', lastSeen: 1 }, p2: { state: 'online', lastSeen: 1 } } };
  assert.equal(macState(offline, 'p1'), 'available', 'reachable, but this phone is not connected to it');
  assert.equal(macLink({ ...base, phase: 'offline' }).state, 'offline');
  assert.equal(macLink({ ...base, phase: 'error' }).online, false);
  // a second Mac while the first is the live one
  assert.equal(macState({ ...base, presence: { p2: { state: 'online', lastSeen: 1 } } }, 'p2'), 'available');
  assert.equal(macState(base, 'p2'), 'offline');
  assert.equal(MAC_WORD.available, 'Available');
});

test('the link names the selected Mac, else the first paired one, and says "Computer" only for a pair that never told its name', () => {
  assert.equal(macLink({ ...base, selectedPair: null, phase: 'offline' }).pairId, 'p1');
  assert.equal(macLink(base, 'p2').name, 'Computer');
  assert.equal(macLink({ ...base, pairs: [{ pairId: 'p1', macId: 'm1', name: '  ' }] }).name, 'Computer');
  const none = macLink({ ...base, pairs: [], selectedPair: null, phase: 'ready' });
  assert.deepEqual([none.pairId, none.state, none.chip], [null, 'offline', 'Computer · Offline']);
});

test('the lines the transcript and the approval card show while the Mac is away', () => {
  assert.equal(QUEUED_LINE, 'Will send when your computer reconnects');
  assert.match(APPROVAL_OFFLINE_LINE, /^Your computer is offline\. /);
});

test('every screen under the provider reads the same link, and a screen drawn alone counts the Mac as connected', async () => {
  const seen: any[] = [];
  const Probe = () => (seen.push(useMacLink()), null);
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  assert.equal(seen.at(-1).online, true, 'nothing is disabled outside the app');
  await act(async () => root.render(createElement(MacLinkProvider, { state: { ...base, phase: 'offline' } }, createElement(Probe))));
  await flush();
  assert.equal(seen.at(-1).chip, 'MacBook Pro · Offline');
  await act(async () => root.render(createElement(MacLinkProvider, { state: base }, createElement(Probe))));
  assert.equal(seen.at(-1).online, true, 'the link follows the snapshot');
  await act(async () => root.unmount());
});

test('a Mac that said it is going to sleep reads Asleep; one simply gone reads Offline, since it may have quit or lost its network', () => {
  const { macWord } = linkModule;
  const away = (presence: any) => ({ ...base, phase: 'offline', selectedPair: null, presence });
  assert.equal(macWord(away({ p1: { state: 'sleeping', lastSeen: 1 } }), 'p1'), 'Asleep');
  assert.equal(macLink(away({ p1: { state: 'sleeping', lastSeen: 1 } }), 'p1').word, 'Asleep');
  assert.equal(macWord(away({ p1: { state: 'gone', lastSeen: 1 } }), 'p1'), 'Offline');
  assert.equal(macWord(away({}), 'p1'), 'Offline');
  assert.equal(macWord({ ...base, presence: { p1: { state: 'online', lastSeen: 1 } } }, 'p1'), 'Connected');
  assert.equal(macLink({ ...base, selectedPair: null, pairs: [] } as any).word, 'Offline', 'no computer at all');
});
