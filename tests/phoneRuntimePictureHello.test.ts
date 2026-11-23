// A queued picture message is sent or refused by what the computer's hello says at the moment it goes out.
import assert from 'node:assert/strict';
import { TEST_RELAY } from './support/phone/testRelay.ts';
import { createHash } from 'node:crypto';
import { mock, test } from 'node:test';
import { withRelay } from './support/phoneAuthFake.ts';
const sessions = new Map<string, any>();
const pairs = [{ pairId: 'p_first', macId: 'mac1', relay: TEST_RELAY }];
mock.module('../mobile/src/platform/crypto.ts', {
  namedExports: {
    phonePrimitives: () => ({
      randomBytes: () => new Uint8Array(16),
      sha256: (bytes: Uint8Array) => createHash('sha256').update(bytes).digest(),
    }),
  },
});
mock.module('../mobile/src/platform/lifecycle.ts', { namedExports: { onForeground: () => () => {} } });
mock.module('../mobile/src/platform/auth.ts', { namedExports: { authorize: async () => ({}), refresh: async () => ({}) } });
mock.module('../mobile/src/platform/vault.ts', { namedExports: { openVaultStorage: async () => ({}) } });
mock.module('../shared/remote/phoneVault.mjs', {
  namedExports: {
    createPhoneVault: () => ({
      pairs: async () => pairs,
      getPending: async () => null,
      claimCleanup: async () => null,
      getPair: async (id: string) => pairs.find((p) => p.pairId === id),
      getInstallId: async () => 'install',
      getLastPair: async () => null,
      setLastPair: async () => {},
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
        signOut: async () => {},
        install: async () => {},
      }),
  },
});
mock.module('../shared/remote/phonePairing.mjs', {
  namedExports: { createPhonePairing: () => ({ status: () => 'idle', cancel: () => {}, begin: async () => ({}) }) },
});
mock.module('../shared/remote/phoneSession.mjs', {
  namedExports: {
    createPhoneSession: (options: any) => {
      const session = {
        options,
        sent: [] as any[],
        close() {},
        send: async (message: any) => void session.sent.push(message),
        receive: async () => {},
      };
      sessions.set(options.pairId, session);
      return session;
    },
  },
});
mock.module('../shared/remote/phoneRelay.mjs', {
  namedExports: {
    createPhoneRelay: () => ({
      close() {},
      connect: async () => ({ pairs: [{ pair: 'p_first', joined: true, peerOnline: true }] }),
      send: async () => {},
      join: async () => {},
      authenticate: async () => {},
    }),
  },
});
const runtimeModulePath = '../mobile/src/runtime.ts';
const { createMobileRuntime } = await import(runtimeModulePath);

for (const supportsPictures of [true, false])
  test(`a queued picture message ${supportsPictures ? 'goes out' : 'is refused with the update line'} by what the computer's hello says when it is sent`, async () => {
    sessions.clear();
    const runtime = createMobileRuntime(TEST_RELAY);
    await runtime.start();
    await runtime.connect('p_first');
    const id = '00000000-0000-4000-8000-000000000000';
    const session = sessions.get('p_first');
    const answer = async (result: unknown) => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      session.options.onMessage({ kind: 'reply', inReplyTo: id, ok: true, result });
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    // the first hello says pictures are understood, so the message may be kept
    const first = runtime.request('machine.hello', {});
    await answer({ capabilities: { messageIdentity: 1, sendId: true } });
    await first;
    runtime.send('c1', '', [], [], undefined, ['file:///one.jpg']);
    // the hello read again just before the message goes out is what decides
    await answer({ capabilities: { sendId: true, ...(supportsPictures ? { messageIdentity: 1 } : {}) } });
    const sent = session.sent.filter((m: any) => m.method === 'chat.send');
    if (supportsPictures) {
      assert.equal(sent.length, 1);
      assert.equal(sent[0].params.images, undefined, 'a picture count never travels as a request field');
    } else {
      assert.equal(sent.length, 0);
      const [queued] = runtime.snapshot().outbox;
      assert.equal(queued.status, 'failed');
      assert.match(String(queued.error), /Update MoPilot on this computer to send pictures/);
    }
    runtime.disconnect();
  });
