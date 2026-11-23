// The phone runtime while it catches up with a computer far ahead: it shows it, and when the walk is done reads everything again by bringing the computer back; a walk that failed or belongs to an old connection changes nothing.
import assert from 'node:assert/strict';
import { TEST_RELAY } from './support/phone/testRelay.ts';
import { mock, test } from 'node:test';
import { withRelay } from './support/phoneAuthFake.ts';

const stored = new Set(['p_first', 'p_second']);
const relayCalls: string[] = [];
const sessions = new Map<string, { closed: boolean; options: any; sent: any[] }>();
let relayUp = false;
let removeFails = false;
let relayRemove: (pair: string) => Promise<unknown> = async () => ({});
let pairingStatus = 'idle';
let answers = true;
let counter = 0;
let sendFails: string | null = null;
const pairRows = () => [...stored].map((pairId) => ({ pairId, macId: pairId, relay: TEST_RELAY }));
mock.module('../mobile/src/platform/crypto.ts', {
  namedExports: {
    phonePrimitives: () => ({
      randomBytes: (n = 16) => Uint8Array.from({ length: n }, (_, i) => (i === 0 ? ++counter & 255 : i === 1 ? (counter >> 8) & 255 : 0)),
    }),
  },
});
mock.module('../mobile/src/platform/lifecycle.ts', { namedExports: { onForeground: () => () => {} } });
mock.module('../mobile/src/platform/auth.ts', { namedExports: { authorize: async () => ({}), refresh: async () => ({}) } });
mock.module('../mobile/src/platform/vault.ts', { namedExports: { openVaultStorage: async () => ({}) } });
mock.module('../shared/remote/phoneVault.mjs', {
  namedExports: {
    createPhoneVault: () => ({
      pairs: async () => pairRows(),
      getPending: async () => null,
      getPair: async (id: string) => pairRows().find((p) => p.pairId === id) ?? null,
      removePair: async (id: string) => {
        if (removeFails) throw new Error('storage unavailable');
        return stored.delete(id);
      },
    }),
  },
});
mock.module('../shared/remote/phoneAuth.mjs', {
  namedExports: {
    createPhoneAuth: () =>
      withRelay({
        restore: async () => ({ user: { id: 'user' } }),
        token: async () => 'token',
        expiresAt: () => Date.now() + 900000,
      }),
  },
});
mock.module('../shared/remote/phonePairing.mjs', {
  namedExports: {
    createPhonePairing: () => ({ status: () => pairingStatus, cancel: () => {}, begin: async () => ({}), finish: async () => ({}) }),
  },
});
mock.module('../shared/remote/phoneSession.mjs', {
  namedExports: {
    createPhoneSession: (o: any) => {
      const session = {
        options: o,
        sent: [] as any[],
        closed: false,
        close() {
          session.closed = true;
        },
        send: async (message: any) => {
          session.sent.push(message);
          if (sendFails) throw new Error(sendFails);
          if (answers) o.onMessage({ kind: 'reply', inReplyTo: message.id, ok: true, result: { app: 'x' } });
        },
      };
      sessions.set(o.pairId, session);
      return session;
    },
  },
});
mock.module('../shared/remote/phoneRelay.mjs', {
  namedExports: {
    createPhoneRelay: () => {
      return {
        close() {
          relayUp = false;
        },
        connected: () => relayUp,
        connect: async () => {
          relayUp = true;
          relayCalls.push('connect');
          return { pairs: [{ pair: 'p_first', joined: true, peerOnline: true }] };
        },
        remove: async (pair: string) => {
          relayCalls.push(`remove:${pair}`);
          return relayRemove(pair);
        },
      };
    },
  },
});
// by variable path, so the node typecheck stays free of React Native types
const runtimeModulePath = '../mobile/src/runtime.ts';
const { createMobileRuntime } = await import(runtimeModulePath);

const reset = () => {
  stored.clear();
  stored.add('p_first');
  stored.add('p_second');
  relayCalls.length = 0;
  sessions.clear();
  relayUp = false;
  removeFails = false;
  relayRemove = async () => ({});
  pairingStatus = 'idle';
  answers = true;
  sendFails = null;
};
const phase = (p: string, pair = 'p_first') => sessions.get(pair)!.options.onCatchUp(p);

test('the walk is shown, and when it is done the computer is brought back so the chat list and the open chat are read again', async () => {
  reset();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  phase('start');
  assert.equal(runtime.snapshot().catchingUp, true);
  assert.equal(runtime.snapshot().phase, 'online', 'still connected while it walks');
  phase('done');
  assert.equal(runtime.snapshot().catchingUp, false);
  assert.equal(runtime.snapshot().phase, 'offline', 'the same path as a computer that went away and came back');
  assert.match(runtime.snapshot().error!, /Catching up/);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(runtime.snapshot().phase, 'online', 'and it connects again by itself');
  runtime.disconnect();
});

test('a walk that failed only stops showing; one for another computer or an old connection is ignored', async () => {
  reset();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  phase('start');
  phase('failed');
  assert.equal(runtime.snapshot().catchingUp, false);
  assert.equal(runtime.snapshot().phase, 'online');
  phase('start', 'p_second');
  assert.notEqual(runtime.snapshot().catchingUp, true, 'a computer that is not the selected one does not show');
  phase('done', 'p_second');
  assert.equal(runtime.snapshot().phase, 'online');
  runtime.disconnect();
});

test('a teardown during the walk clears the flag, and the walk of the connection that is gone ends without bringing it back', async () => {
  for (const end of ['failed', 'done']) {
    reset();
    const runtime = createMobileRuntime(TEST_RELAY);
    await runtime.start();
    await runtime.connect('p_first');
    const handler = sessions.get('p_first')!.options.onCatchUp;
    handler('start');
    assert.equal(runtime.snapshot().catchingUp, true);
    runtime.disconnect();
    assert.equal(runtime.snapshot().catchingUp, false, 'the teardown itself clears it');
    handler(end);
    assert.equal(runtime.snapshot().catchingUp, false, end);
    assert.notEqual(runtime.snapshot().error, 'Catching up with your computer…', 'nothing reconnects for a connection that is gone');
  }
});
