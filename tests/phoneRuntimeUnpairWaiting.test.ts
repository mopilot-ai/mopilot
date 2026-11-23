// Removing a computer while the phone is offline and waiting for another one: the wait for that other computer carries on.
import assert from 'node:assert/strict';
import { TEST_RELAY } from './support/phone/testRelay.ts';
import { mock, test } from 'node:test';
import { withRelay } from './support/phoneAuthFake.ts';

const stored = new Set(['p_first', 'p_second']);
let relayOptions: any;
let relayUp = false;
let peerOnline = false;
let onRemoveAtRelay: (pair: string) => void = () => {};
let afterRemovedCheck: () => void = () => {};
let removedChecks = 0;
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
      getPair: async (id: string) => {
        const row = pairRows().find((p) => p.pairId === id) ?? null;
        // the check that follows a removal (the outbox of a computer that is gone) is where a test can act in between
        if (id === 'p_second' && !row) {
          removedChecks++;
          afterRemovedCheck();
        }
        return row;
      },
      removePair: async (id: string) => stored.delete(id),
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
    createPhonePairing: () => ({ status: () => 'idle', cancel: () => {}, begin: async () => ({}), finish: async () => ({}) }),
  },
});
mock.module('../shared/remote/phoneSession.mjs', {
  namedExports: { createPhoneSession: () => ({ close() {} }) },
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
        acker: { enabled: () => true },
        connect: async () => {
          relayUp = true;
          return { pairs: [{ pair: 'p_first', joined: true, peerOnline }] };
        },
        remove: async (pair: string) => onRemoveAtRelay(pair),
      };
    },
  },
});
// by variable path, so the node typecheck stays free of React Native types
const runtimeModulePath = '../mobile/src/runtime.ts';
const { createMobileRuntime } = await import(runtimeModulePath);

/** A phone that tapped p_first while its computer was away, and whose relay connection then closed: it waits for p_first with no relay open. */
const waitingFor = async () => {
  stored.clear();
  stored.add('p_first');
  stored.add('p_second');
  relayUp = false;
  peerOnline = false;
  removedChecks = 0;
  onRemoveAtRelay = () => {};
  afterRemovedCheck = () => {};
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await assert.rejects(runtime.connect('p_first'), /offline/);
  relayOptions.onClose();
  assert.equal(runtime.snapshot().phase, 'offline');
  assert.equal(relayUp, false);
  assert.equal(runtime.snapshot().reconnect?.pairId, 'p_first');
  return runtime;
};

test('removing another computer ends the wait with the relay it opened, and the wait for this one starts again', async () => {
  const runtime = await waitingFor();
  const waits: Array<string | null> = [];
  runtime.subscribe(() => waits.push(runtime.snapshot().reconnect?.pairId ?? null));
  await runtime.unpair('p_second');
  assert.deepEqual(
    runtime.snapshot().pairs.map((p: any) => p.pairId),
    ['p_first'],
  );
  assert.equal(removedChecks > 0, true);
  // the removal stopped the wait, and it began again for the computer still paired
  assert.equal(waits.includes(null), true);
  assert.equal(runtime.snapshot().reconnect?.pairId, 'p_first');
  assert.equal(runtime.snapshot().phase, 'offline');
  runtime.disconnect();
});

test('the wait is not started again for a computer that is gone too', async () => {
  const runtime = await waitingFor();
  // this computer removed the phone while the other one was being removed
  onRemoveAtRelay = () => void stored.delete('p_first');
  await runtime.unpair('p_second');
  assert.deepEqual(runtime.snapshot().pairs, []);
  assert.equal(runtime.snapshot().reconnect, null);
  runtime.disconnect();
});

test('a wait that something else already began again is left alone', async () => {
  const runtime = await waitingFor();
  // a tap on the computer holds the pair the moment the removal has finished
  afterRemovedCheck = () => void runtime.connect('p_first').catch(() => {});
  await runtime.unpair('p_second');
  assert.equal(runtime.snapshot().reconnect?.pairId, 'p_first');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.snapshot().phase, 'offline');
  runtime.disconnect();
});

test('a flood as the removal ends reconnects to the computer in use instead of ending in an error', async () => {
  const runtime = await waitingFor();
  // the relay floods the phone as the removal ends: it reconnects by itself instead of showing an error
  afterRemovedCheck = () => {
    for (let i = 0; i < 5001; i++) relayOptions.onFrame({ pair: 'p_first', ctr: i });
  };
  await runtime.unpair('p_second');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.snapshot().phase, 'offline');
  assert.equal(runtime.snapshot().reconnect?.pairId, 'p_first');
  runtime.disconnect();
});

test('removing the computer being waited for, or removing while nothing is waited for, starts no wait', async () => {
  const runtime = await waitingFor();
  await runtime.unpair('p_first');
  assert.equal(runtime.snapshot().reconnect, null);
  runtime.disconnect();
  stored.add('p_first');
  const idle = createMobileRuntime(TEST_RELAY);
  await idle.start();
  await idle.unpair('p_second');
  assert.equal(idle.snapshot().reconnect, null);
  idle.disconnect();
});
