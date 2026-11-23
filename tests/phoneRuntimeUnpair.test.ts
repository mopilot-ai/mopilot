// The phone runtime's wiring of "remove this computer" and of the relay telling it a computer removed this phone.
import assert from 'node:assert/strict';
import { TEST_RELAY } from './support/phone/testRelay.ts';
import { mock, test } from 'node:test';
import { withRelay } from './support/phoneAuthFake.ts';

const stored = new Set(['p_first', 'p_second']);
const relayCalls: string[] = [];
const sessions = new Map<string, { closed: boolean }>();
let relayOptions: any;
let relayUp = false;
let removeFails = false;
let relayRemove: (pair: string) => Promise<unknown> = async () => ({});
let pairingStatus = 'idle';
const pairRows = () => [...stored].map((pairId) => ({ pairId, macId: pairId, relay: TEST_RELAY }));
mock.module('../mobile/src/platform/crypto.ts', { namedExports: { phonePrimitives: () => ({ randomBytes: () => new Uint8Array(16) }) } });
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
        closed: false,
        close() {
          session.closed = true;
        },
      };
      sessions.set(o.pairId, session);
      return session;
    },
  },
});
mock.module('../shared/remote/phoneRelay.mjs', {
  namedExports: {
    createPhoneRelay: (o: any) => {
      relayOptions = o;
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
};
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

test('an offline phone opens the relay for the removal, deletes the pair and closes the relay again', async () => {
  reset();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.unpair('p_first');
  assert.deepEqual(relayCalls, ['connect', 'remove:p_first']);
  assert.deepEqual(
    runtime.snapshot().pairs.map((p) => p.pairId),
    ['p_second'],
  );
  assert.equal(relayUp, false);
  assert.equal(runtime.snapshot().error, null);
  runtime.disconnect();
});

test('the open connection carries the removal, and only the removed computer’s channel closes', async () => {
  reset();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  relayCalls.length = 0;
  const generation = runtime.snapshot().generation;
  await runtime.unpair('p_second');
  assert.deepEqual(relayCalls, ['remove:p_second']);
  assert.equal(sessions.get('p_second')!.closed, true);
  assert.equal(sessions.get('p_first')!.closed, false);
  assert.equal(runtime.snapshot().phase, 'online');
  assert.equal(runtime.snapshot().generation, generation);
  await runtime.unpair('p_first');
  assert.equal(runtime.snapshot().phase, 'offline');
  assert.equal(runtime.snapshot().selectedPair, null);
  assert.deepEqual(runtime.snapshot().pairs, []);
  runtime.disconnect();
});

test('a relay that cannot be reached leaves a note and the pair is gone anyway', async () => {
  reset();
  relayRemove = async () => {
    throw new Error('relay: forbidden');
  };
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.unpair('p_first');
  assert.match(runtime.snapshot().error!, /Remove this phone on your computer as well/);
  assert.equal(stored.has('p_first'), false);
  runtime.disconnect();
});

test('removal is refused before the vault opened and while a pairing is unfinished', async () => {
  reset();
  const early = createMobileRuntime(TEST_RELAY);
  await assert.rejects(early.unpair('p_first'), /Secure storage unavailable/);
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  pairingStatus = 'waiting';
  await assert.rejects(runtime.unpair('p_first'), /Finish or cancel pairing first/);
  assert.equal(stored.has('p_first'), true);
  pairingStatus = 'idle';
  runtime.disconnect();
});

test('a computer that removed this phone disappears from the list; the open one stays until it is the removed one', async () => {
  reset();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  relayOptions.onEvent({ ev: 'pair.removed', pair: 'p_second' });
  await settle();
  assert.deepEqual(
    runtime.snapshot().pairs.map((p) => p.pairId),
    ['p_first'],
  );
  assert.equal(runtime.snapshot().phase, 'online');
  relayOptions.onEvent({ ev: 'pair.removed', pair: 'p_first' });
  await settle();
  assert.deepEqual(runtime.snapshot().pairs, []);
  assert.equal(runtime.snapshot().phase, 'error');
  runtime.disconnect();
});

test('a storage failure while forgetting a removed computer is shown, not swallowed', async () => {
  reset();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  removeFails = true;
  relayOptions.onEvent({ ev: 'pair.removed', pair: 'p_second' });
  await settle();
  assert.equal(runtime.snapshot().phase, 'error');
  assert.match(runtime.snapshot().error!, /storage unavailable/);
  runtime.disconnect();
});
