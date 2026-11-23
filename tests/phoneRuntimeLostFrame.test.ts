// A frame the phone cannot read that arrives while its computer is still being connected ends the connection visibly (the line and Pair again), instead of closing the channel silently and leaving requests to time out.
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
let relayOptions: any;
let receiveError: Error | null = null;
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
        receive: async () => {
          if (receiveError) throw receiveError;
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
  answers = true;
  sendFails = null;
};
const lost = async () => {
  const { RemoteCryptoError } = await import('../shared/remote/crypto.mjs');
  return new RemoteCryptoError('lost', 'this computer is too far ahead to catch up');
};

test('a frame that cannot be read, arriving while the computer is being connected, ends the connection with the line', async () => {
  reset();
  receiveError = await lost();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  const connecting = runtime.connect('p_first');
  // the relay's backlog reaches the pair before the connection has chosen it
  relayOptions.onFrame({ pair: 'p_first', ctr: 1 });
  await connecting.catch(() => undefined);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(runtime.snapshot().phase, 'error');
  assert.match(runtime.snapshot().error!, /Can't read this computer's messages/);
  receiveError = null;
  runtime.disconnect();
});

test('a frame of another computer that cannot be read still closes only that channel', async () => {
  reset();
  receiveError = await lost();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  relayOptions.onFrame({ pair: 'p_second', ctr: 1 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(runtime.snapshot().phase, 'online');
  assert.equal(sessions.get('p_second')!.closed, true);
  receiveError = null;
  runtime.disconnect();
});
