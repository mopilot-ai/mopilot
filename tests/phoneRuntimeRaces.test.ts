// Reversed completion tests for connection, pairing and sign-out ownership.
import assert from 'node:assert/strict';
import { TEST_RELAY } from './support/phone/testRelay.ts';
import { mock, test } from 'node:test';
import { withRelay } from './support/phoneAuthFake.ts';
const runtimeModulePath = '../mobile/src/runtime.ts';
const deferred = () => {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let storedPairs: any[] = [],
  relayRead: Promise<any> | null = null,
  expiryHook: (() => void) | null = null,
  restoreGate: Promise<any> | null = null;
const account = { user: { id: 'user' } };
mock.module('../mobile/src/platform/crypto.ts', { namedExports: { phonePrimitives: () => ({ randomBytes: () => new Uint8Array(16) }) } });
mock.module('../mobile/src/platform/lifecycle.ts', { namedExports: { onForeground: () => () => {} } });
mock.module('../mobile/src/platform/auth.ts', { namedExports: { authorize: async () => ({}), refresh: async () => ({}) } });
mock.module('../mobile/src/platform/vault.ts', { namedExports: { openVaultStorage: async () => ({}) } });
mock.module('../shared/remote/phoneVault.mjs', {
  namedExports: {
    createPhoneVault: () => ({
      pairs: async () => storedPairs,
      getPending: async () => null,
      claimCleanup: async () => null,
      getPair: async () => ({ pairId: 'p_first' }),
    }),
  },
});
mock.module('../shared/remote/phoneAuth.mjs', {
  namedExports: {
    createPhoneAuth: () =>
      withRelay({
        restore: async () => restoreGate ?? account,
        signOut: async () => {},
        token: async () => 'token',
        expiresAt: () => {
          expiryHook?.();
          return Date.now() + 900000;
        },
      }),
  },
});
mock.module('../shared/remote/phonePairing.mjs', {
  namedExports: {
    createPhonePairing: (o: any) => ({
      status: () => 'idle',
      cancel: () => {},
      begin: async () => {
        await o.transport.join(TEST_RELAY, 'p_new');
        return { safetyNumber: '123456' };
      },
    }),
  },
});
mock.module('../shared/remote/phoneSession.mjs', { namedExports: { createPhoneSession: () => ({ close() {}, send: async () => {} }) } });
mock.module('../shared/remote/phoneRelay.mjs', {
  namedExports: {
    createPhoneRelay: () => ({ close() {}, join: async () => {}, connect: () => relayRead ?? Promise.resolve({ pairs: [] }) }),
  },
});
const { createMobileRuntime } = await import(runtimeModulePath);

test('retirement between relay opening and caller continuation blocks connect and pairing join', async () => {
  storedPairs = [{ pairId: 'p_first', macId: 'mac', relay: TEST_RELAY }];
  relayRead = Promise.resolve({ pairs: [{ pair: 'p_first', joined: true, peerOnline: true }] });
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  expiryHook = () => {
    expiryHook = null;
    queueMicrotask(() => runtime.disconnect());
  };
  await assert.rejects(runtime.connect('p_first'), /cancelled/);
  expiryHook = () => {
    expiryHook = null;
    queueMicrotask(() => runtime.disconnect());
  };
  await assert.rejects(runtime.pair('{}', 'Phone'), /cancelled/);
  runtime.disconnect();
  storedPairs = [];
  relayRead = null;
});

test('overlapping sign-outs retire the older completion', async () => {
  const gate = deferred();
  restoreGate = gate.promise;
  const runtime = createMobileRuntime(TEST_RELAY);
  const start = runtime.start();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  const first = runtime.signOut(),
    second = runtime.signOut();
  gate.resolve(account);
  await Promise.all([start, first, second]);
  assert.equal(runtime.snapshot().phase, 'signedOut');
  restoreGate = null;
});

test('a queued old timeout cannot cancel a replacement request with the same id', async () => {
  const originalSet = globalThis.setTimeout,
    originalClear = globalThis.clearTimeout;
  const timers: Array<{ fn: () => void; delay: number }> = [];
  globalThis.setTimeout = ((fn: () => void, delay: number) => {
    timers.push({ fn, delay });
    return timers.length;
  }) as any;
  globalThis.clearTimeout = (() => {}) as any;
  storedPairs = [{ pairId: 'p_first', macId: 'mac', relay: TEST_RELAY }];
  relayRead = Promise.resolve({ pairs: [{ pair: 'p_first', joined: true, peerOnline: true }] });
  const runtime = createMobileRuntime(TEST_RELAY);
  try {
    await runtime.start();
    await runtime.connect('p_first');
    const old = runtime.request('chat.list', {});
    const oldTimer = timers.find((entry) => entry.delay === 30000)!;
    runtime.disconnect();
    await assert.rejects(old, /closed/);
    await runtime.connect('p_first');
    const next = runtime.request('chat.list', {});
    oldTimer.fn();
    await Promise.resolve();
    runtime.disconnect();
    await assert.rejects(next, /closed/);
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
    storedPairs = [];
    relayRead = null;
  }
});
