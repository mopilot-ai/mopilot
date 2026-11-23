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
const resync = (pair = 'p_first') => sessions.get(pair)!.options.onMessage({ kind: 'event', ev: 'pair.resync', patch: { reason: 'gap' } });

test('a resync notice from a computer that still answers is stale: nothing changes', async () => {
  reset();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  const heard: string[] = [];
  runtime.onEvent((e: any) => heard.push(e.ev));
  resync();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runtime.snapshot().phase, 'online');
  assert.equal(sessions.get('p_first')!.sent.at(-1).method, 'machine.hello', 'one cheap request decided it');
  assert.deepEqual(heard, ['pair.resync'], 'listeners still hear the notice');
  runtime.disconnect();
});

test('a resync notice from a computer that is silent says what to do, and keeps the pair so it can be removed', async () => {
  reset();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  answers = false;
  // the 8 s wait for the computer's answer is shortened; every other timer is the real one
  const realSet = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: any, ms: any, ...a: any[]) => realSet(fn, ms === 8000 ? 10 : ms, ...a)) as any;
  try {
    resync();
    await new Promise((r) => realSet(r, 120));
  } finally {
    globalThis.setTimeout = realSet;
  }
  assert.equal(runtime.snapshot().phase, 'error');
  assert.match(runtime.snapshot().error!, /stopped accepting messages.*Restart MoPilot.*pair it again/);
  assert.deepEqual(
    runtime.snapshot().pairs.map((p: any) => p.pairId),
    ['p_first', 'p_second'],
  );
  runtime.disconnect();
});

test('a notice checked while the link itself fails reconnects instead of blaming the computer, and the pair can be opened again after an error', async () => {
  reset();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  sendFails = 'relay disconnected';
  resync();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runtime.snapshot().phase, 'offline');
  assert.match(runtime.snapshot().error!, /Reconnecting/);
  runtime.disconnect();
  sendFails = null;
  await runtime.connect('p_first');
  answers = false;
  const realSet = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: any, ms: any, ...a: any[]) => realSet(fn, ms === 8000 ? 10 : ms, ...a)) as any;
  try {
    resync();
    await new Promise((r) => realSet(r, 120));
  } finally {
    globalThis.setTimeout = realSet;
  }
  assert.equal(runtime.snapshot().phase, 'error');
  answers = true;
  await runtime.connect('p_first');
  assert.equal(runtime.snapshot().phase, 'online', 'tapping the computer again works');
  runtime.disconnect();
});
