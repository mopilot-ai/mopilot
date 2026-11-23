// The phone runtime when the relay turns it away: a full relay or an account at its device limit shows why, keeps the reason through the tries that follow and waits the refusal's time between them; an account switched off stops trying and says so.
import assert from 'node:assert/strict';
import { TEST_RELAY } from './support/phone/testRelay.ts';
import { mock, test } from 'node:test';
import { REFUSAL_TEXT, RelayRefused } from '../shared/remote/relayRefusal.mjs';

/** What the relay does with each socket the phone opens: closes it with a code, or says hello. The real relay client (shared/remote/phoneRelay.mjs) runs over it. */
type Answer = { close: number } | { hello: object };
let answer: () => Answer = () => ({ hello: { pairs: [] } });
let token: () => Promise<string> = async () => 'relay-token';
let connects = 0;
const sockets: any[] = [];
const pair = { pairId: 'p_first', macId: 'm', relay: TEST_RELAY };
mock.module('../mobile/src/platform/socket.ts', {
  namedExports: {
    openPhoneSocket: () => {
      connects++;
      const socket: any = { send() {}, close() {} };
      sockets.push(socket);
      const what = answer();
      queueMicrotask(() =>
        'close' in what
          ? socket.onclose?.({ code: what.close })
          : socket.onmessage?.({ data: JSON.stringify({ t: 'hello', ...what.hello }) }),
      );
      return socket;
    },
  },
});
mock.module('../mobile/src/platform/crypto.ts', { namedExports: { phonePrimitives: () => ({ randomBytes: () => new Uint8Array(16) }) } });
mock.module('../mobile/src/platform/lifecycle.ts', { namedExports: { onForeground: () => () => {} } });
mock.module('../mobile/src/platform/auth.ts', { namedExports: { authorize: async () => ({}), refresh: async () => ({}) } });
mock.module('../mobile/src/platform/vault.ts', { namedExports: { openVaultStorage: async () => ({}) } });
mock.module('../shared/remote/phoneVault.mjs', {
  namedExports: { createPhoneVault: () => ({ pairs: async () => [pair], getPending: async () => null, getPair: async () => pair }) },
});
mock.module('../shared/remote/phoneAuth.mjs', {
  namedExports: {
    createPhoneAuth: () => ({
      restore: async () => ({ user: { id: 'user' } }),
      token: async () => 'access',
      expiresAt: () => Date.now() + 900_000,
      relayToken: () => token(),
      relayExpiresAt: () => Date.now() + 900_000,
    }),
  },
});
mock.module('../shared/remote/phonePairing.mjs', {
  namedExports: { createPhonePairing: () => ({ status: () => 'idle', cancel: () => {} }) },
});
mock.module('../shared/remote/phoneSession.mjs', { namedExports: { createPhoneSession: () => ({ close() {} }) } });
// by variable path, so the node typecheck stays free of React Native types
const runtimeModulePath = '../mobile/src/runtime.ts';
const { createMobileRuntime } = await import(runtimeModulePath);

const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
const away = () => ({ hello: { pairs: [{ pair: 'p_first', joined: true, peerOnline: false }] } });

async function started(t: any) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.method(Math, 'random', () => 0.999999);
  connects = 0;
  sockets.length = 0;
  answer = () => ({ hello: { pairs: [] } });
  token = async () => 'relay-token';
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  t.after(() => runtime.disconnect());
  return runtime;
}

test('a tap the relay refuses as full shows why, and the phone asks again by itself after 15 s, then 30 s, keeping the reason', async (t) => {
  const runtime = await started(t);
  answer = () => ({ close: 4503 });
  await assert.rejects(runtime.connect('p_first'), /at capacity/);
  let s = runtime.snapshot();
  assert.deepEqual([s.phase, s.error, s.refusal], ['offline', REFUSAL_TEXT.capacity, 'capacity']);
  assert.equal(s.reconnect?.pairId, 'p_first');
  assert.equal(s.reconnect!.nextAt! - Date.now(), 15_000, 'not the one-second wait of a computer that is away');
  assert.equal(connects, 1);
  t.mock.timers.tick(14_000);
  await settle();
  assert.equal(connects, 1);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(connects, 2);
  s = runtime.snapshot();
  assert.deepEqual([s.phase, s.refusal, s.error], ['offline', 'capacity', REFUSAL_TEXT.capacity]);
  assert.equal(s.reconnect!.nextAt! - Date.now(), 15_000, 'the first refusal of the phone’s own tries');
  t.mock.timers.tick(15_000);
  await settle();
  assert.equal(connects, 3);
  assert.equal(runtime.snapshot().reconnect!.nextAt! - Date.now(), 30_000, 'and the wait doubles');
  // the relay has room again, the computer is simply away: the reason goes
  answer = away;
  t.mock.timers.tick(30_000);
  await settle();
  s = runtime.snapshot();
  assert.deepEqual([s.phase, s.refusal, s.error], ['offline', null, 'Computer is offline']);
  runtime.disconnect();
  assert.equal(runtime.snapshot().refusal, null);
});

test('a live socket the relay closes with a refusal says which, and an ordinary close does not', async (t) => {
  const runtime = await started(t);
  // the relay lists the computer, which is away: the phone waits for it
  answer = away;
  await assert.rejects(runtime.connect('p_first'), /offline/);
  // the relay keeps listening for the computer's return on this socket; the relay closes it
  sockets.at(-1).onclose({ code: 4429 });
  let s = runtime.snapshot();
  assert.deepEqual([s.phase, s.error, s.refusal], ['offline', REFUSAL_TEXT.account_limit, 'account_limit']);
  assert.equal(s.reconnect?.pairId, 'p_first', 'the next try learns whether the relay still refuses');
  t.mock.timers.tick(1000);
  await settle();
  sockets.at(-1).onclose({ code: 1006 });
  s = runtime.snapshot();
  assert.deepEqual([s.error, s.refusal], ['Relay disconnected', null]);
});

test('an account switched off: the account service refuses the token, the phone says so and stops trying', async (t) => {
  const runtime = await started(t);
  // the relay lists the computer, which is away: the phone waits for it
  answer = away;
  await assert.rejects(runtime.connect('p_first'), /offline/);
  token = async () => Promise.reject(new RelayRefused('disabled'));
  sockets.at(-1).onclose({ code: 4423 });
  let s = runtime.snapshot();
  assert.deepEqual([s.phase, s.error, s.refusal], ['offline', REFUSAL_TEXT.disabled, 'disabled']);
  assert.equal(s.reconnect!.nextAt! - Date.now(), 1000, 'asked of the account service at once: it says whether the switch still holds');
  t.mock.timers.tick(1000);
  await settle();
  s = runtime.snapshot();
  assert.deepEqual([s.phase, s.error, s.refusal, s.reconnect], ['error', REFUSAL_TEXT.disabled, 'disabled', null]);
  t.mock.timers.tick(600_000);
  await settle();
  assert.equal(connects, 1, 'nothing dials again');
  // a tap that is refused the same way reads the same
  await assert.rejects(runtime.connect('p_first'), /turned off for this account/);
  assert.deepEqual([runtime.snapshot().phase, runtime.snapshot().refusal], ['error', 'disabled']);
});
