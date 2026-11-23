// The phone runtime's handling of the computer's `pair.resync` notice: a request decides whether the notice is still true.
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
const missed = (pair = 'p_first') =>
  sessions.get(pair)!.options.onMessage({ kind: 'event', ev: 'live.missed', patch: { reason: 'late-presence' } });

test('live.missed on the selected pair takes the connected phone offline and back online, and listeners still hear it', async () => {
  reset();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  const generation = runtime.snapshot().generation;
  const heard: string[] = [];
  runtime.onEvent((e: any) => heard.push(e.ev));
  missed();
  assert.equal(runtime.snapshot().phase, 'offline', 'the connection is dropped at once');
  assert.match(runtime.snapshot().error!, /Catching up with your computer/);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(runtime.snapshot().phase, 'online', 'and the reconnect (no wait) brings it back');
  assert.equal(runtime.snapshot().selectedPair, 'p_first');
  assert.ok(runtime.snapshot().generation > generation, 'a new connection: every screen reads again');
  assert.deepEqual(heard, ['live.missed']);
  runtime.disconnect();
});

test('live.missed for a pair that is not the selected one is ignored', async () => {
  reset();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  const first = sessions.get('p_first')!;
  runtime.disconnect(); // no pair is selected: this channel's pair is not the selected one
  const before = runtime.snapshot();
  first.options.onMessage({ kind: 'event', ev: 'live.missed', patch: {} });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runtime.snapshot().generation, before.generation, 'no connection was dropped or started');
  assert.equal(runtime.snapshot().phase, before.phase);
  assert.equal(runtime.snapshot().error, before.error);
  runtime.disconnect();
});
