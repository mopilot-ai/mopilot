// A burst of relay frames past the phone's inbox cap reconnects by itself and resumes from the first unprocessed frame, once and in order.
import assert from 'node:assert/strict';
import { TEST_RELAY } from './support/phone/testRelay.ts';
import { mock, test } from 'node:test';
import { withRelay } from './support/phoneAuthFake.ts';
import { waitFor } from './support/waitFor.ts';

const pairs = [{ pairId: 'p_first', macId: 'mac1', relay: TEST_RELAY }];
let relayOptions: any;
let connects = 0;
let acking = true;
let resend: (() => void) | null = null;
let relayConnectFails = false;
let receive: (frame: any) => Promise<void> = async () => {};
mock.module('../mobile/src/platform/crypto.ts', { namedExports: { phonePrimitives: () => ({ randomBytes: () => new Uint8Array(16) }) } });
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
      removePair: async () => false,
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
  namedExports: {
    createPhonePairing: () => ({
      status: () => 'waiting',
      cancel: () => {},
      begin: async () => ({}),
      finish: async () => ({ pairId: 'p_first' }),
    }),
  },
});
mock.module('../shared/remote/phoneSession.mjs', {
  namedExports: {
    createPhoneSession: (options: any) => ({ options, close() {}, send: async () => {}, receive: (frame: any) => receive(frame) }),
  },
});
mock.module('../shared/remote/phoneRelay.mjs', {
  namedExports: {
    createPhoneRelay: (options: any) => {
      relayOptions = options;
      return {
        close() {},
        acker: { enabled: () => acking },
        connect: async () => {
          connects++;
          if (relayConnectFails && connects > 1) throw new Error('relay connection timed out');
          // the relay resends what was never acked, in order, on every new socket
          if (resend) setTimeout(resend, 0);
          return { pairs: [{ pair: 'p_first', joined: true, peerOnline: true }] };
        },
      };
    },
  },
});
const runtimeModulePath = '../mobile/src/runtime.ts';
const { createMobileRuntime } = await import(runtimeModulePath);
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test('a backlog of a few thousand frames is applied in order without the phone ever leaving online or reconnecting', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  const before = connects;
  const seen: Array<[string, string | null]> = [];
  runtime.subscribe(() => seen.push([runtime.snapshot().phase, runtime.snapshot().error]));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const handled: number[] = [];
  receive = async (frame) => {
    await gate;
    handled.push(frame.ctr);
  };
  for (let i = 1; i <= 3000; i++) relayOptions.onFrame({ pair: 'p_first', ctr: i });
  release();
  await settle(60);
  assert.equal(handled.length, 3000);
  assert.deepEqual(handled.slice(0, 3), [1, 2, 3]);
  assert.equal(connects, before, 'catching up did not reconnect');
  assert.equal(
    seen.some(([phase, error]) => phase !== 'online' || error !== null),
    false,
    'nothing visible changed while it caught up',
  );
  runtime.disconnect();
});

test('a burst past the cap catches up on a fresh socket without the phone leaving online or showing anything', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  const before = connects;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const handled: number[] = [];
  let acked = 0;
  receive = async (frame) => {
    await gate;
    handled.push(frame.ctr);
    acked = frame.ctr;
  };
  resend = () => {
    for (let i = acked + 1; i <= 5450; i++) relayOptions.onFrame({ pair: 'p_first', ctr: i });
  };
  for (let i = 1; i <= 5450; i++) relayOptions.onFrame({ pair: 'p_first', ctr: i });
  assert.equal(runtime.snapshot().phase, 'online', 'a full inbox is not an error while it drains');
  const seen: Array<[string, string | null]> = [];
  runtime.subscribe(() => seen.push([runtime.snapshot().phase, runtime.snapshot().error]));
  release();
  // drained, not a fixed sleep: a loaded runner needs longer than an idle one to apply 5450 frames and reconnect
  await waitFor(() => handled.length >= 5450 && connects - before >= 1, 'every frame applied on the fresh socket');
  await settle(20);
  assert.deepEqual(
    handled,
    Array.from({ length: 5450 }, (_, i) => i + 1),
    'every frame once and in order',
  );
  assert.equal(connects - before, 1, 'one fresh socket for the rest');
  assert.equal(
    seen.some(([phase, error]) => phase !== 'online' || error !== null),
    false,
    'nothing visible changed: no offline phase, no reconnecting text, no error',
  );
  resend = null;
  runtime.disconnect();
});

test('a catch-up whose reconnect fails is visible, as any lost connection is', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  receive = async () => {};
  relayConnectFails = true;
  for (let i = 1; i <= 5100; i++) relayOptions.onFrame({ pair: 'p_first', ctr: i });
  await settle(40);
  relayConnectFails = false;
  assert.equal(runtime.snapshot().phase, 'offline');
  runtime.disconnect();
});

test('a backlog many times the cap is delivered once and in order, each reconnect making progress', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  const handled: number[] = [];
  let acked = 0;
  let rounds = 0;
  receive = async (frame) => {
    handled.push(frame.ctr);
    acked = frame.ctr;
  };
  while (acked < 12000) {
    await runtime.connect('p_first');
    // the relay resends everything unacked, in order, as fast as it can
    for (let i = acked + 1; i <= 12000; i++) relayOptions.onFrame({ pair: 'p_first', ctr: i });
    assert.ok(++rounds <= 6, 'recovery loops on a backlog larger than the cap');
    // each round applies the 5000 frames the inbox holds; wait for them instead of a fixed sleep
    await waitFor(() => handled.length >= Math.min(rounds * 5000, 12000), `round ${rounds} applied`);
    await settle(20);
  }
  assert.deepEqual(
    handled,
    Array.from({ length: 12000 }, (_, i) => i + 1),
  );
  assert.equal(rounds, 3);
  runtime.disconnect();
});

test('overflows with no progress back off instead of reconnecting at full speed', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  receive = async () => {};
  const before = connects;
  for (let round = 0; round < 3; round++) {
    await runtime.connect('p_first');
    for (let i = 1; i <= 5450; i++) relayOptions.onFrame({ pair: 'p_first', ctr: i });
    await settle();
  }
  // three taps, and one immediate reconnect after the first overflow; the repeats wait for the usual backoff
  assert.equal(connects - before, 4);
  runtime.disconnect();
});

test('a frame that fails to process still ends the connection with an error', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  receive = async () => {
    throw new Error('receive failed');
  };
  relayOptions.onFrame({ pair: 'p_first', ctr: 1 });
  await settle();
  assert.equal(runtime.snapshot().phase, 'error');
  assert.match(runtime.snapshot().error ?? '', /receive failed/);
  runtime.disconnect();
});

test('a relay that does not keep frames until acked cannot resend them, so an overflow there is an error', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  acking = false;
  receive = () => new Promise(() => {});
  for (let i = 1; i <= 5250; i++) relayOptions.onFrame({ pair: 'p_first', ctr: i });
  assert.equal(runtime.snapshot().phase, 'error');
  assert.match(runtime.snapshot().error ?? '', /overflow/);
  acking = true;
  runtime.disconnect();
});

test('large frames hit the byte cap long before the count cap and are left to the relay', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  const handled: number[] = [];
  receive = async (frame) => {
    handled.push(frame.ctr);
  };
  const box = 'x'.repeat(1024 * 1024);
  // 40 MB of frames queued while the first is being handled: past 32 MB the rest waits at the relay
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  receive = async (frame) => {
    await gate;
    handled.push(frame.ctr);
  };
  for (let i = 1; i <= 40; i++) relayOptions.onFrame({ pair: 'p_first', ctr: i, box });
  release();
  await waitFor(() => handled.length >= 32, 'the frames under the byte cap applied');
  await settle(20);
  assert.ok(handled.length <= 34 && handled.length >= 32, `handled ${handled.length}`);
  runtime.disconnect();
});
