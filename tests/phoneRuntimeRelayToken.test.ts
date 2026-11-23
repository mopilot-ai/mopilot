// The runtime shows the relay the relay's token, never the access token, and renews it by that token's own expiry.
import assert from 'node:assert/strict';
import { TEST_RELAY } from './support/phone/testRelay.ts';
import { mock, test } from 'node:test';
const runtimeModulePath = '../mobile/src/runtime.ts';

const log: string[] = [];
let relayLife = 300_000;
let minted = 0;
mock.module('../mobile/src/platform/crypto.ts', { namedExports: { phonePrimitives: () => ({ randomBytes: () => new Uint8Array(16) }) } });
mock.module('../mobile/src/platform/lifecycle.ts', { namedExports: { onForeground: () => () => {} } });
mock.module('../mobile/src/platform/auth.ts', { namedExports: { authorize: async () => ({}), refresh: async () => ({}) } });
mock.module('../mobile/src/platform/vault.ts', { namedExports: { openVaultStorage: async () => ({}) } });
mock.module('../shared/remote/phoneVault.mjs', {
  namedExports: { createPhoneVault: () => ({ pairs: async () => [], getPending: async () => null, claimCleanup: async () => null }) },
});
mock.module('../shared/remote/phoneAuth.mjs', {
  namedExports: {
    createPhoneAuth: () => ({
      restore: async () => ({ user: { id: 'user' } }),
      signOut: async () => {},
      // the access token must never reach the relay: its life is long, so a timer taken from it would be wrong too
      token: async () => 'ACCESS-TOKEN',
      expiresAt: () => Date.now() + 900_000,
      relayToken: async (force?: boolean) => `relay-${force ? 'forced' : 'first'}-${++minted}`,
      relayExpiresAt: () => Date.now() + relayLife,
    }),
  },
});
mock.module('../shared/remote/phonePairing.mjs', {
  namedExports: { createPhonePairing: () => ({ status: () => 'idle', cancel: () => {} }) },
});
mock.module('../shared/remote/phoneSession.mjs', { namedExports: { createPhoneSession: () => ({ close() {} }) } });
mock.module('../shared/remote/phoneRelay.mjs', {
  namedExports: {
    createPhoneRelay: () => ({
      close: () => {},
      connected: () => false,
      connect: async (_url: string, token: string) => (log.push(`connect:${token}`), { pairs: [] }),
      authenticate: async (token: string) => void log.push(`authenticate:${token}`),
      registerPush: async () => undefined,
    }),
  },
});
const { createMobileRuntime } = await import(runtimeModulePath);

test('the relay is shown the relay token and renewed a minute before that token ends, not by the access token’s life', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const runtime = createMobileRuntime(TEST_RELAY);
    await runtime.start();
    await runtime.pushRegister('apns', 'tok');
    assert.deepEqual(log, ['connect:relay-first-1']);
    // 300 s of life, renewed 60 s before the end: 240 s from now (the access token's 900 s would say 600 s)
    mock.timers.tick(239_000);
    await Promise.resolve();
    assert.equal(log.length, 1, 'not renewed early');
    mock.timers.tick(2_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(log.slice(1), ['authenticate:relay-forced-2']);
    assert.ok(!log.some((line) => line.includes('ACCESS-TOKEN')));
    runtime.disconnect();
  } finally {
    mock.timers.reset();
  }
});
