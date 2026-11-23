// The app returning after a real absence replaces the relay socket the OS may have left half open: the relay's unacked frames come on a fresh one, once and in order, with the phone staying online.
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
let probes = 0;
let probeFails = false;
let receive: (frame: any) => Promise<void> = async () => {};
mock.module('../mobile/src/platform/crypto.ts', {
  namedExports: {
    phonePrimitives: () => ({ randomBytes: () => new Uint8Array(16) }),
  },
});
let foreground: ((awayMs: number) => void) | null = null;
mock.module('../mobile/src/platform/lifecycle.ts', {
  namedExports: {
    onForeground: (fn: (awayMs: number) => void) => {
      foreground = fn;
      return () => {
        foreground = null;
      };
    },
  },
});
mock.module('../mobile/src/platform/auth.ts', {
  namedExports: { authorize: async () => ({}), refresh: async () => ({}) },
});
mock.module('../mobile/src/platform/vault.ts', {
  namedExports: { openVaultStorage: async () => ({}) },
});
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
    createPhoneSession: (options: any) => ({
      options,
      close() {},
      send: async () => {},
      receive: (frame: any) => receive(frame),
    }),
  },
});
mock.module('../shared/remote/phoneRelay.mjs', {
  namedExports: {
    createPhoneRelay: (options: any) => {
      relayOptions = options;
      return {
        close() {},
        acker: { enabled: () => acking },
        authenticate: async () => {
          probes++;
          if (probeFails) throw new Error('relay acknowledgement timed out');
        },
        connect: async () => {
          connects++;
          if (relayConnectFails && connects > 1) throw new Error('relay connection timed out');
          // the relay resends what was never acked, in order, on every new socket
          if (resend) setTimeout(resend, 0);
          return {
            pairs: [{ pair: 'p_first', joined: true, peerOnline: true }],
          };
        },
      };
    },
  },
});
const runtimeModulePath = '../mobile/src/runtime.ts';
const { createMobileRuntime } = await import(runtimeModulePath);
const { REOPEN_AFTER_AWAY_MS } = await import('../mobile/src/inboxCatchUp.ts');
const { QUIET_MS } = await import('../mobile/src/relayLiveness.ts');
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const online = async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  runtime.subscribe(() => {});
  return runtime;
};

test('a return after a real absence fetches what the relay holds on a fresh socket, in order, without leaving online', async () => {
  const runtime = await online();
  const before = connects;
  const handled: number[] = [];
  let acked = 0;
  receive = async (frame) => {
    handled.push(frame.ctr);
    acked = frame.ctr;
  };
  // frames 1-3 were delivered; 4-9 sat unacked at the relay while the old socket delivered nothing
  for (let i = 1; i <= 3; i++) relayOptions.onFrame({ pair: 'p_first', ctr: i });
  await waitFor(() => handled.length === 3, 'first frames applied');
  resend = () => {
    for (let i = acked + 1; i <= 9; i++) relayOptions.onFrame({ pair: 'p_first', ctr: i });
  };
  const seen: Array<[string, string | null]> = [];
  runtime.subscribe(() => seen.push([runtime.snapshot().phase, runtime.snapshot().error]));
  foreground!(REOPEN_AFTER_AWAY_MS);
  await waitFor(() => handled.length === 9, 'the rest applied from the fresh socket');
  assert.equal(connects - before, 1, 'one fresh socket');
  assert.deepEqual(handled, [1, 2, 3, 4, 5, 6, 7, 8, 9], 'every frame once and in order');
  assert.equal(
    seen.some(([phase, error]) => phase !== 'online' || error !== null),
    false,
    'nothing visible changed',
  );
  resend = null;
  runtime.disconnect();
});

test('a short absence keeps the socket it has', async () => {
  const runtime = await online();
  const before = connects;
  foreground!(REOPEN_AFTER_AWAY_MS - 1);
  foreground!(0);
  await settle();
  assert.equal(connects, before);
  runtime.disconnect();
});

test('a return while frames are still being applied waits for the inbox to empty, then replaces the socket once', async () => {
  const runtime = await online();
  const before = connects;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const handled: number[] = [];
  receive = async (frame) => {
    await gate;
    handled.push(frame.ctr);
  };
  for (let i = 1; i <= 5; i++) relayOptions.onFrame({ pair: 'p_first', ctr: i });
  foreground!(REOPEN_AFTER_AWAY_MS);
  foreground!(REOPEN_AFTER_AWAY_MS);
  await settle();
  assert.equal(connects, before, 'frames waiting in the inbox are not thrown away by a reconnect');
  release();
  await waitFor(() => connects - before === 1, 'reopened after the inbox emptied');
  await settle(30);
  assert.equal(handled.length, 5);
  assert.equal(connects - before, 1, 'once');
  runtime.disconnect();
});

test('a connection that ended while the return waited for the inbox is not reopened', async () => {
  const runtime = await online();
  const before = connects;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  receive = async () => {
    await gate;
  };
  relayOptions.onFrame({ pair: 'p_first', ctr: 1 });
  foreground!(REOPEN_AFTER_AWAY_MS);
  runtime.disconnect();
  release();
  await settle(30);
  assert.equal(connects, before);
});

test('a computer being waited for is only kicked on return, with no second socket from the reopen', async () => {
  const runtime = await online();
  relayOptions.onClose();
  assert.equal(runtime.snapshot().phase, 'offline');
  const before = connects;
  foreground!(REOPEN_AFTER_AWAY_MS * 10);
  assert.equal(connects, before, 'the reconnector paces its own attempt; nothing is opened at once');
  runtime.disconnect();
});

test('a reopen that fails is visible, as any lost connection is', async () => {
  const runtime = await online();
  receive = async () => {};
  relayConnectFails = true;
  foreground!(REOPEN_AFTER_AWAY_MS);
  await settle(40);
  relayConnectFails = false;
  assert.equal(runtime.snapshot().phase, 'offline');
  runtime.disconnect();
});

const turns = () => new Promise((resolve) => setImmediate(resolve));
const quietRuntime = async () => {
  probes = 0;
  probeFails = false;
  mock.timers.enable({ apis: ['setInterval'] });
  return online();
};

test('an online socket that went quiet and does not answer is replaced, with the phone staying online', async () => {
  try {
    const runtime = await quietRuntime();
    const before = connects;
    const seen: Array<[string, string | null]> = [];
    runtime.subscribe(() => seen.push([runtime.snapshot().phase, runtime.snapshot().error]));
    probeFails = true;
    // a real second passes in the test's clock: the socket has been quiet since it was opened
    const now = Date.now;
    Date.now = () => now() + QUIET_MS;
    mock.timers.tick(QUIET_MS);
    await turns();
    await turns();
    Date.now = now;
    assert.equal(probes, 1);
    assert.equal(connects - before, 1, 'one fresh socket');
    assert.equal(runtime.snapshot().phase, 'online');
    assert.equal(
      seen.some(([phase, error]) => phase !== 'online' || error !== null),
      false,
    );
    runtime.disconnect();
  } finally {
    mock.timers.reset();
  }
});

test('a quiet socket that answers is kept, and a socket that keeps receiving frames is never asked', async () => {
  try {
    const runtime = await quietRuntime();
    const before = connects;
    receive = async () => {};
    const now = Date.now;
    Date.now = () => now() + QUIET_MS;
    mock.timers.tick(QUIET_MS);
    await turns();
    assert.equal(probes, 1);
    assert.equal(connects, before, 'it answered: nothing is replaced');
    // a frame just arrived: the next check finds it heard from, and asks nothing
    relayOptions.onFrame({ pair: 'p_first', ctr: 1 });
    mock.timers.tick(QUIET_MS);
    await turns();
    Date.now = now;
    assert.equal(probes, 1);
    runtime.disconnect();
  } finally {
    mock.timers.reset();
  }
});

test('a disconnected runtime asks nothing', async () => {
  try {
    const runtime = await quietRuntime();
    runtime.disconnect();
    const now = Date.now;
    Date.now = () => now() + QUIET_MS * 3;
    mock.timers.tick(QUIET_MS * 3);
    await turns();
    Date.now = now;
    assert.equal(probes, 0);
  } finally {
    mock.timers.reset();
  }
});
