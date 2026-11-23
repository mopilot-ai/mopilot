// The runtime gives the phone auth the account module's revoke, so signing out ends the session at the account service.
import assert from 'node:assert/strict';
import { TEST_RELAY } from './support/phone/testRelay.ts';
import { mock, test } from 'node:test';
import { withRelay } from './support/phoneAuthFake.ts';
const runtimeModulePath = '../mobile/src/runtime.ts';

const revoked: string[] = [];
const deleted: Array<[string, string]> = [];
let authOptions: any;
mock.module('../mobile/src/platform/crypto.ts', { namedExports: { phonePrimitives: () => ({ randomBytes: () => new Uint8Array(16) }) } });
mock.module('../mobile/src/platform/lifecycle.ts', { namedExports: { onForeground: () => () => {} } });
mock.module('../mobile/src/platform/auth.ts', {
  namedExports: {
    authorize: async () => ({}),
    refresh: async () => ({}),
    revoke: async (token: string) => (revoked.push(token), true),
    deleteAccount: async (token: string, confirm: string) => void deleted.push([token, confirm]),
    accountFeatures: async (token: string) => [token === 'token' ? 'phone' : 'wrong token'],
  },
});
mock.module('../mobile/src/platform/vault.ts', { namedExports: { openVaultStorage: async () => ({}) } });
mock.module('../shared/remote/phoneVault.mjs', {
  namedExports: { createPhoneVault: () => ({ pairs: async () => [], getPending: async () => null, claimCleanup: async () => null }) },
});
mock.module('../shared/remote/phoneAuth.mjs', {
  namedExports: {
    createPhoneAuth: (options: any) => {
      authOptions = options;
      return withRelay({
        restore: async () => ({ user: { id: 'user' } }),
        token: async () => 'token',
        expiresAt: () => Date.now() + 900000,
        signOut: async () => {},
      });
    },
  },
});
mock.module('../shared/remote/phonePairing.mjs', {
  namedExports: { createPhonePairing: () => ({ status: () => 'idle', cancel: () => {} }) },
});
const { createMobileRuntime } = await import(runtimeModulePath);

test('the phone auth is made with the account module’s refresh and revoke', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  assert.equal(await authOptions.revoke('held-refresh-token'), true);
  assert.equal(await authOptions.refresh('x').then(() => 'ok'), 'ok');
  assert.deepEqual(revoked, ['held-refresh-token']);
});

test('deleting the account sends the access token and the confirmation to the account service, and refuses before storage is open', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  await assert.rejects(runtime.deleteAccount('a@b.co'), /Secure storage unavailable/);
  await runtime.start();
  await runtime.deleteAccount('a@b.co');
  assert.deepEqual(deleted, [['token', 'a@b.co']]);
});

test('the invite is asked with the access token, and before start there is nothing to ask with', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  assert.equal(await runtime.features(), null);
  await runtime.start();
  assert.deepEqual(await runtime.features(), ['phone']);
});
