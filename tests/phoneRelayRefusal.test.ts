// The relay's refusals on the phone below the runtime: the socket that reports them, the reconnector that waits them out, and the home page that says what is true instead of "Your computer is offline".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPhoneRelay } from '../shared/remote/phoneRelay.mjs';
import { REFUSAL_TEXT, RelayRefused } from '../shared/remote/relayRefusal.mjs';
import { createReconnector, isPassingRefusal, isTransient } from '../mobile/src/reconnect.ts';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
const appPath = '../mobile/src/MobileApp';
const { MobileApp } = await import(appPath);

function socketRig() {
  const sockets: any[] = [];
  const closes: unknown[] = [];
  const relay = createPhoneRelay({
    open: () => {
      const ws: any = { send() {}, close() {} };
      sockets.push(ws);
      return ws;
    },
    onFrame: () => {},
    onEvent: () => {},
    onClose: (refusal) => closes.push(refusal),
  });
  return { relay, sockets, closes };
}

test('a socket the relay closes with a refusal before its hello fails the connect with that refusal; any other close is a lost connection', async () => {
  for (const [code, refusal] of [
    [4503, 'capacity'],
    [4429, 'account_limit'],
    [4423, 'disabled'],
  ] as const) {
    const { relay, sockets, closes } = socketRig();
    const connecting = relay.connect('wss://relay.example/v1/ws', 't');
    sockets[0].onclose({ code });
    await assert.rejects(
      connecting,
      (e: unknown) => e instanceof RelayRefused && e.refusal === refusal && e.message === REFUSAL_TEXT[refusal],
    );
    assert.deepEqual(closes, [refusal]);
  }
  for (const event of [{ code: 1006 }, {}, undefined]) {
    const { relay, sockets, closes } = socketRig();
    const connecting = relay.connect('wss://relay.example/v1/ws', 't');
    sockets[0].onclose(event);
    await assert.rejects(connecting, /^Error: relay connection closed$/);
    assert.deepEqual(closes, [null]);
  }
});

test('an open socket closed with a refusal tells the runtime which', async () => {
  const { relay, sockets, closes } = socketRig();
  const connecting = relay.connect('wss://relay.example/v1/ws', 't');
  sockets[0].onmessage({ data: JSON.stringify({ t: 'hello' }) });
  await connecting;
  sockets[0].onclose({ code: 4423 });
  assert.deepEqual(closes, ['disabled']);
  assert.equal(relay.connected(), false);
});

test('a full relay and an account at its device limit pass by themselves; an account switched off does not', () => {
  assert.equal(isTransient(new RelayRefused('capacity')), true);
  assert.equal(isTransient(new RelayRefused('account_limit')), true);
  assert.equal(isTransient(new RelayRefused('disabled')), false);
  assert.deepEqual([new RelayRefused('capacity'), new RelayRefused('disabled'), new Error('x'), null].map(isPassingRefusal), [
    true,
    false,
    false,
    false,
  ]);
});

test('a refused attempt waits 15 s doubling to 5 minutes instead of the short wait, a nudge does not shorten it, and an ordinary miss starts the count again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const outcomes: string[] = ['refused', 'refused', 'refused', 'retry', 'refused', 'connected'];
  const attempts: number[] = [];
  const states: any[] = [];
  const start = Date.now();
  const reconnector = createReconnector({
    attempt: async () => {
      attempts.push(Date.now() - start);
      return outcomes.shift() as any;
    },
    timing: { baseMs: 100, capMs: 400, jitter: 0, minGapMs: 50 },
    onChange: (s) => states.push(s),
    random: () => 0.999999,
  });
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const tick = async (ms: number) => {
    t.mock.timers.tick(ms);
    await settle();
  };
  reconnector.start('p', 0);
  await settle();
  assert.deepEqual(attempts, [0]);
  assert.equal(states.at(-1).nextAt - Date.now(), 15_000);
  // the computer cannot have announced itself to a phone the relay turned away, and a stray nudge is still held to the minimum gap only
  await tick(14_999);
  assert.deepEqual(attempts, [0]);
  await tick(1);
  assert.deepEqual(attempts, [0, 15_000]);
  await tick(30_000);
  assert.deepEqual(attempts, [0, 15_000, 45_000]);
  assert.equal(states.at(-1).nextAt - Date.now(), 60_000);
  await tick(60_000);
  // an ordinary miss: the short wait, and the next refusal starts at 15 s again
  assert.equal(states.at(-1).nextAt - Date.now(), 400);
  await tick(400);
  assert.equal(states.at(-1).nextAt - Date.now(), 15_000);
  await tick(15_000);
  assert.equal(states.at(-1), null, 'connected');
  // a stop forgets the refusals too
  outcomes.push('refused', 'refused');
  reconnector.start('p', 0);
  await settle();
  reconnector.stop();
  reconnector.start('p', 0);
  await settle();
  assert.equal(states.at(-1).nextAt - Date.now(), 15_000);
  reconnector.stop();
});

test('the home page says the relay is at capacity instead of "Your computer is offline", and goes back to that line when the reason is gone', async () => {
  const listeners = new Set<() => void>();
  const s = scripted(() => undefined, {
    phase: 'offline',
    generation: 1,
    user: { id: 'u' },
    pairs: [{ pairId: 'p1', macId: 'm1', name: 'Studio Mac' }],
    selectedPair: null,
    safetyNumber: null,
    pendingPair: false,
    error: REFUSAL_TEXT.capacity,
    refusal: 'capacity',
    presence: {},
  });
  s.runtime.start = async () => {};
  s.runtime.subscribe = (f: () => void) => (listeners.add(f), () => listeners.delete(f));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime })));
  await flush();
  assert.match(host.textContent!, /Mobile Remote is at capacity\. Try again shortly\./);
  assert.doesNotMatch(host.textContent!, /Your computer is offline/);
  s.state.snap = { ...s.state.snap, error: 'Relay disconnected', refusal: null };
  await act(async () => listeners.forEach((f) => f()));
  await flush();
  assert.doesNotMatch(host.textContent!, /at capacity/);
  assert.match(host.textContent!, /Your computer is offline\. Your chats show here once it reconnects\./);
  await act(async () => root.unmount());
  host.remove();
});

test('an account at its pair cap reads why it could not pair, not a protocol word', async () => {
  const { pairFailure } = await import('../mobile/src/pairingLog.ts');
  const { relay, sockets } = socketRig();
  const connecting = relay.connect('wss://relay.example/v1/ws', 't');
  const sent: any[] = [];
  sockets[0].send = (text: string) => sent.push(JSON.parse(text));
  sockets[0].onmessage({ data: JSON.stringify({ t: 'hello' }) });
  await connecting;
  const joining = relay.join('p_12345678');
  sockets[0].onmessage({ data: JSON.stringify({ t: 'error', code: 'pair_limit', rid: sent[0].rid }) });
  const error = await joining.catch((e: Error) => e);
  assert.equal((error as Error).message, 'relay: pair_limit');
  assert.equal(pairFailure(error), 'This account has too many connected computers. Remove one in Settings, then scan a new code.');
});
