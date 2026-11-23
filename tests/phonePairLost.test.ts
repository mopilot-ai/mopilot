// A computer the phone cannot catch up with says so in a few words and offers to pair that computer again, never Sign out as the only way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
const appPath = '../mobile/src/MobileApp';
const lostPath = '../mobile/src/pairLost';
const refusedPath = '../mobile/src/relayRefused';
const cryptoPath = '../shared/remote/crypto.mjs';
const { MobileApp } = await import(appPath);
const { PAIR_LOST_LINE } = await import(lostPath);
const { errorLine } = await import(refusedPath);
const { RemoteCryptoError } = await import(cryptoPath);

test('the catch-up failure shows its own line; any other error keeps its words', () => {
  assert.equal(errorLine(new RemoteCryptoError('lost', 'x')), PAIR_LOST_LINE);
  assert.equal(
    PAIR_LOST_LINE,
    "Can't read this computer's messages. Try again, or pair it again.",
    'one forged frame must not tell the person to pair again as the only way',
  );
  assert.equal(errorLine(new RemoteCryptoError('gap', 'too many frames are missing')), 'too many frames are missing');
  assert.equal(errorLine(new Error('boom')), 'boom');
  assert.equal(errorLine('nope'), 'Operation failed');
});

test('the line offers Retry and Pair again; pairing again removes only that computer', async () => {
  const calls: string[] = [];
  const snapshot = {
    generation: 1,
    phase: 'error',
    user: { id: 'u' },
    error: PAIR_LOST_LINE,
    pairs: [{ pairId: 'p', macId: 'm', name: 'Studio Mac' }],
    selectedPair: 'p',
    safetyNumber: null,
    pendingPair: false,
    presence: {},
    reconnect: null,
    outbox: [],
    pairCleanup: false,
  };
  const runtime: any = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    start: async () => void calls.push('start'),
    signOut: async () => void calls.push('signOut'),
    connect: async (pair: string) => void calls.push(`connect:${pair}`),
    unpair: async (pair: string) => void calls.push(`unpair:${pair}`),
    request: async () => ({}),
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime })));
  await flush();
  assert.match(host.textContent!, /Can't read this computer's messages/);
  const labels = () => [...host.querySelectorAll('button')].map((b) => b.textContent);
  assert.ok(labels().includes('Retry'));
  await click('Retry');
  assert.ok(calls.includes('connect:p'), 'Retry connects again (a new session), nothing is removed');
  assert.ok(!calls.includes('unpair:p'));
  assert.match(host.textContent!, /Tried again just now: still the same\./, 'a Retry that ends on the same line says so');
  await click('Pair again');
  assert.ok(calls.includes('unpair:p'), 'that computer is removed');
  assert.ok(!calls.includes('signOut'), 'the account stays');
  await act(async () => root.unmount());
  host.remove();
});

test('while the phone walks its counters forward the home screen says it is catching up', async () => {
  const snapshot = {
    generation: 1,
    phase: 'ready',
    user: { id: 'u' },
    error: null,
    catchingUp: true,
    pairs: [{ pairId: 'p', macId: 'm', name: 'Studio Mac' }],
    selectedPair: 'p',
    safetyNumber: null,
    pendingPair: false,
    presence: {},
    reconnect: null,
    outbox: [],
    pairCleanup: false,
  };
  const runtime: any = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    start: async () => {},
    connect: async () => {},
    request: async () => ({}),
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime })));
  await flush();
  assert.match(host.textContent!, /Catching up with your computer/);
  await act(async () => root.unmount());
  host.remove();
});

test('a Retry that passes through offline and ends on the same line still says so; another error clears it, and an online moment inside a Retry does not', async () => {
  const snap: any = {
    generation: 1,
    phase: 'error',
    user: { id: 'u' },
    error: PAIR_LOST_LINE,
    pairs: [{ pairId: 'p', macId: 'm', name: 'Studio Mac' }],
    selectedPair: 'p',
    safetyNumber: null,
    pendingPair: false,
    presence: {},
    reconnect: null,
    outbox: [],
    pairCleanup: false,
  };
  const listeners = new Set<() => void>();
  const set = async (patch: object) => {
    Object.assign(snap, patch, { generation: snap.generation + 1 });
    await act(async () => listeners.forEach((l) => l()));
  };
  const runtime: any = {
    snapshot: () => ({ ...snap }),
    subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
    start: async () => {},
    signOut: async () => {},
    connect: async () => {
      // what the runtime really does: leaves the error, tries, and lands on the same line
      await set({ phase: 'offline', error: 'Reconnecting…' });
      await set({ phase: 'error', error: PAIR_LOST_LINE });
    },
    unpair: async () => {},
    request: async () => ({}),
    onEvent: () => () => {},
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime })));
  await flush();
  await click('Retry');
  await flush();
  assert.match(host.textContent!, /Tried again just now: still the same\./, 'the retry went through offline and the note stayed');
  await set({ phase: 'error', error: 'Something else went wrong' });
  assert.doesNotMatch(host.textContent!, /Tried again just now/, 'another error clears it');
  await click('Retry');
  await set({ phase: 'offline', error: 'Reconnecting…' });
  await set({ phase: 'online', error: null });
  await set({ phase: 'error', error: PAIR_LOST_LINE });
  assert.match(
    host.textContent!,
    /Tried again just now: still the same\./,
    'the retry reached online before the next frame was refused again, and the note stayed',
  );
  await act(async () => root.unmount());
  host.remove();
});
