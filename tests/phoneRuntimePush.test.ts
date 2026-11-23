// Push token registration rides the runtime's one relay socket, connecting it first when it is not up.
import assert from 'node:assert/strict';
import { TEST_RELAY } from './support/phone/testRelay.ts';
import { mock, test } from 'node:test';
import { withRelay } from './support/phoneAuthFake.ts';
const runtimeModulePath = '../mobile/src/runtime.ts';

const log: string[] = [];
let open = false;
let connectError: Error | null = null;
mock.module('../mobile/src/platform/crypto.ts', { namedExports: { phonePrimitives: () => ({ randomBytes: () => new Uint8Array(16) }) } });
mock.module('../mobile/src/platform/lifecycle.ts', { namedExports: { onForeground: () => () => {} } });
mock.module('../mobile/src/platform/auth.ts', { namedExports: { authorize: async () => ({}), refresh: async () => ({}) } });
mock.module('../mobile/src/platform/vault.ts', { namedExports: { openVaultStorage: async () => ({}) } });
mock.module('../shared/remote/phoneVault.mjs', {
  namedExports: { createPhoneVault: () => ({ pairs: async () => [], getPending: async () => null, claimCleanup: async () => null }) },
});
mock.module('../shared/remote/phoneAuth.mjs', {
  namedExports: {
    createPhoneAuth: () =>
      withRelay({
        restore: async () => ({ user: { id: 'user' } }),
        token: async () => 'token',
        expiresAt: () => Date.now() + 900000,
        signOut: async () => {},
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
      close: () => void (open = false),
      connected: () => open,
      connect: async () => {
        if (connectError) throw connectError;
        open = true;
        log.push('connect');
        return { pairs: [] };
      },
      registerPush: async (platform: string, token: string) => void log.push(`register:${platform}:${token}`),
      unregisterPush: async () => void log.push('unregister'),
      registerActivity: async (token: string) => void log.push(`activity:${token}`),
      unregisterActivity: async () => void log.push('activity.unregister'),
    }),
  },
});
const { createMobileRuntime } = await import(runtimeModulePath);

test('register and unregister connect the relay once when it is down and reuse it when it is up', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.pushRegister('apns', 'tok');
  await runtime.pushUnregister();
  assert.deepEqual(log, ['connect', 'register:apns:tok', 'unregister']);
  runtime.disconnect();
  await runtime.pushUnregister();
  assert.deepEqual(log.slice(3), ['connect', 'unregister']);
  runtime.disconnect();
});

test('the Live Activity token rides the same socket, connecting it first when it is down', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  log.length = 0;
  await runtime.activityRegister('ab');
  await runtime.activityUnregister();
  assert.deepEqual(log, ['connect', 'activity:ab', 'activity.unregister']);
  runtime.disconnect();
  await runtime.activityUnregister();
  assert.deepEqual(log.slice(3), ['connect', 'activity.unregister']);
  connectError = new Error('relay connection failed');
  runtime.disconnect();
  await assert.rejects(runtime.activityRegister('cd'), /connection failed/);
  connectError = null;
  runtime.disconnect();
});

test('a relay that cannot be reached rejects the registration so the next sync retries it', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  connectError = new Error('relay connection failed');
  await assert.rejects(runtime.pushRegister('fcm', 'tok'), /connection failed/);
  await assert.rejects(runtime.pushUnregister(), /connection failed/);
  connectError = null;
});
