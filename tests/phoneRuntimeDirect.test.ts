// The runtime and the phone's own paths to its Hosts (X3, X4): they are opened with the vault, asked at launch (once signed in) and on every return to the front, and given the host-chat flag the app hands over.
import assert from 'node:assert/strict';
import { TEST_RELAY } from './support/phone/testRelay.ts';
import { mock, test } from 'node:test';
import { withRelay } from './support/phoneAuthFake.ts';
const runtimeModulePath = '../mobile/src/runtime.ts';

let returnToFront: ((awayMs: number) => void) | null = null;
let probes = 0;
let restored: { user: { id: string } } | null = { user: { id: 'user' } };
mock.module('../mobile/src/platform/crypto.ts', { namedExports: { phonePrimitives: () => ({ randomBytes: () => new Uint8Array(16) }) } });
mock.module('../mobile/src/platform/lifecycle.ts', {
  namedExports: { onForeground: (fn: (awayMs: number) => void) => ((returnToFront = fn), () => {}) },
});
mock.module('../mobile/src/platform/auth.ts', { namedExports: { authorize: async () => ({}), refresh: async () => ({}) } });
mock.module('../mobile/src/platform/vault.ts', { namedExports: { openVaultStorage: async () => ({}) } });
mock.module('../shared/remote/phoneVault.mjs', {
  namedExports: {
    createPhoneVault: () => ({
      pairs: async () => [],
      getPending: async () => null,
      claimCleanup: async () => null,
      getLastPair: async () => null,
      getOutbox: async () => null,
      setOutbox: async () => undefined,
    }),
  },
});
mock.module('../shared/remote/phoneAuth.mjs', {
  namedExports: {
    createPhoneAuth: () =>
      withRelay({
        restore: async () => restored,
        token: async () => 'token',
        expiresAt: () => Date.now() + 900000,
        signOut: async () => {},
      }),
  },
});
mock.module('../shared/remote/phonePairing.mjs', {
  namedExports: { createPhonePairing: () => ({ status: () => 'idle', cancel: () => {} }) },
});
// the phone's own paths are checked in their own tests; here only that the runtime opens and asks them (#4604)
mock.module('../mobile/src/remote/directHosts.ts', {
  namedExports: { createDirectHosts: (options: any) => ({ options, probe: () => void probes++ }) },
});
const { createMobileRuntime } = await import(runtimeModulePath);

test('the phone asks its enrolled machines when its paths open and every time it returns to the front', async () => {
  probes = 0;
  const runtime = createMobileRuntime(TEST_RELAY);
  const off = runtime.subscribe(() => {});
  await runtime.start();
  assert.equal(probes, 1, 'at launch, so a machine reads right before its page is opened');
  returnToFront!(30_000);
  assert.equal(probes, 2, 'and when the app comes back');
  off();
  // with no sign-in to restore a probe would read every machine as away: it waits for one
  probes = 0;
  restored = null;
  const signedOut = createMobileRuntime(TEST_RELAY);
  await signedOut.start();
  assert.equal(probes, 0);
  restored = { user: { id: 'user' } };
});

test('the phone’s own paths exist once the vault is open, and not before', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  assert.equal(runtime.direct, null);
  await runtime.start();
  assert.ok(runtime.direct);
});

test('the host-chat flag the app hands the runtime is loaded with the vault and given to the phone’s own paths', async () => {
  const log: string[] = [];
  const flag = {
    load: async () => void log.push('load'),
    on: () => true,
    why: () => 'build',
    told: () => undefined,
    subscribe: () => () => undefined,
  };
  const runtime = createMobileRuntime(undefined, false, flag);
  await runtime.start();
  assert.deepEqual(log, ['load']);
  assert.equal(runtime.direct.options.hostChat, flag);
  const failing = createMobileRuntime(undefined, false, { ...flag, load: () => Promise.reject(new Error('keychain')) });
  await failing.start();
  assert.ok(failing.direct, 'a flag that cannot load does not stop the phone');
});
