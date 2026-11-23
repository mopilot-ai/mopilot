// Runtime ownership rejects delayed storage, token and relay completions after disconnect.
import assert from 'node:assert/strict';
import { TEST_RELAY } from './support/phone/testRelay.ts';
import { mock, test } from 'node:test';
import { withRelay } from './support/phoneAuthFake.ts';
const runtimeModulePath = '../mobile/src/runtime.ts';

const deferred = () => {
  let resolve!: (v: any) => void;
  const promise = new Promise<any>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let pairRead: Promise<any> | null = null,
  tokenRead: Promise<any> | null = null,
  relayRead: Promise<any> | null = null;
let sockets = 0;
let expiry = 900000,
  renewCount = 0,
  authCount = 0;
let storedPairs: any[] = [];
let pairingStatus = 'idle';
let finishGate: Promise<any> | null = null;
let installIdGate: Promise<any> | null = null;
let restoreGate: Promise<any> | null = null,
  installGate: Promise<any> | null = null;
let relayOptions: any;
let receives = 0,
  receiveGate: Promise<any> | null = null;
let sessionOptions: any,
  sendError: unknown = null;
let foreground: (() => void) | null = null;
let foregroundCleanups = 0;
let storageFailure: unknown = null;
let account: any = { user: { id: 'user' } };
mock.module('../mobile/src/platform/crypto.ts', { namedExports: { phonePrimitives: () => ({ randomBytes: () => new Uint8Array(16) }) } });
mock.module('../mobile/src/platform/lifecycle.ts', {
  namedExports: {
    onForeground: (fn: () => void) => {
      foreground = fn;
      return () => {
        foreground = null;
        foregroundCleanups++;
      };
    },
  },
});
mock.module('../mobile/src/platform/auth.ts', {
  namedExports: { authorize: async () => ({ user: { id: 'new-user' } }), refresh: async () => ({}) },
});
mock.module('../mobile/src/platform/vault.ts', {
  namedExports: {
    openVaultStorage: async () => {
      if (storageFailure) throw storageFailure;
      return {};
    },
  },
});
mock.module('../shared/remote/phoneVault.mjs', {
  namedExports: {
    createPhoneVault: () => ({
      pairs: () => pairRead ?? Promise.resolve(storedPairs),
      getPending: async () => null,
      claimCleanup: async () => null,
      getInstallId: async () => installIdGate ?? 'install',
      getPair: async () => ({ pairId: 'p_first', relay: TEST_RELAY }),
    }),
  },
});
mock.module('../shared/remote/phoneAuth.mjs', {
  namedExports: {
    createPhoneAuth: () =>
      withRelay({
        restore: async () => restoreGate ?? account,
        install: async () => {
          if (installGate) await installGate;
        },
        signOut: async () => {},
        token: (force: boolean) => {
          if (force) renewCount++;
          return tokenRead ?? Promise.resolve('token');
        },
        expiresAt: () => {
          return Date.now() + expiry;
        },
      }),
  },
});
mock.module('../shared/remote/phonePairing.mjs', {
  namedExports: {
    createPhonePairing: (options: any) => ({
      status: () => pairingStatus,
      cancel: () => {},
      finish: () => finishGate,
      begin: async () => {
        await options.transport.join(TEST_RELAY, 'p_new');
        return { safetyNumber: '123456' };
      },
    }),
  },
});
mock.module('../shared/remote/phoneSession.mjs', {
  namedExports: {
    createPhoneSession: (options: any) => {
      sessionOptions = options;
      return {
        close() {},
        receive: async () => {
          receives++;
          if (receiveGate) await receiveGate;
        },
        send: async () => {
          if (sendError) throw sendError;
        },
      };
    },
  },
});
mock.module('../shared/remote/phoneRelay.mjs', {
  namedExports: {
    createPhoneRelay: (options: any) => {
      relayOptions = options;
      return {
        close() {},
        join: async () => {},
        authenticate: async () => {
          authCount++;
        },
        connect: () => {
          sockets++;
          return relayRead ?? Promise.resolve({ pairs: [] });
        },
      };
    },
  },
});
const { createMobileRuntime } = await import(runtimeModulePath);

test('empty pair read after disconnect cannot revive routing or open the socket', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  const gate = deferred();
  pairRead = gate.promise;
  const pending = runtime.connect('p_first');
  await Promise.resolve();
  await Promise.resolve();
  runtime.disconnect();
  gate.resolve([]);
  await assert.rejects(pending, /cancelled/);
  assert.equal(sockets, 0);
  pairRead = null;
});

test('late token cannot open a retired connection', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  const gate = deferred();
  tokenRead = gate.promise;
  const pending = runtime.connect('p_first');
  for (let i = 0; i < 5; i++) await Promise.resolve();
  runtime.disconnect();
  gate.resolve('token');
  await assert.rejects(pending, /cancelled/);
  assert.equal(sockets, 0);
  tokenRead = null;
});

test('late socket hello cannot publish online after disconnect', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  const gate = deferred();
  relayRead = gate.promise;
  const pending = runtime.connect('p_first');
  for (let i = 0; i < 8; i++) await Promise.resolve();
  runtime.disconnect();
  gate.resolve({ pairs: [{ pair: 'p_first', joined: true, peerOnline: true }] });
  await assert.rejects(pending, /cancelled/);
  assert.notEqual(runtime.snapshot().phase, 'online');
  relayRead = null;
});

test('unexpected frame accessor error terminates the connection visibly', async () => {
  storedPairs = [{ pairId: 'p_first', relay: TEST_RELAY }];
  relayRead = Promise.resolve({ pairs: [{ pair: 'p_first', joined: true, peerOnline: true }] });
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  pairingStatus = 'waiting';
  relayOptions.onFrame({
    ctr: 0,
    get pair() {
      throw new Error('invalid frame');
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(runtime.snapshot().phase, 'error');
  pairingStatus = 'idle';
  runtime.disconnect();
  storedPairs = [];
  relayRead = null;
});

test('requests before connection and sign-out after unavailable storage fail visibly', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  await assert.rejects(runtime.request('chat.list', {}), /Connect/);
  const broken = createMobileRuntime(TEST_RELAY);
  // This runtime has not opened storage, so sign-out cannot silently report success.
  await assert.rejects(broken.signOut(), /storage unavailable/);
});

test('a pair stored for another relay cannot be opened', async () => {
  storedPairs = [{ pairId: 'p_first', relay: 'wss://other.example/v1/ws' }];
  relayRead = Promise.resolve({ pairs: [{ pair: 'p_first', joined: true, peerOnline: true }] });
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await assert.rejects(runtime.connect('p_first'), /relay does not match/);
  runtime.disconnect();
  storedPairs = [];
  relayRead = null;
});

test('token refresh starts before an already aging access token expires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  expiry = 120000;
  renewCount = 0;
  storedPairs = [{ pairId: 'p_first', relay: TEST_RELAY }];
  relayRead = Promise.resolve({ pairs: [{ pair: 'p_first', joined: true, peerOnline: true }] });
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  t.mock.timers.tick(59999);
  assert.equal(renewCount, 0);
  t.mock.timers.tick(1);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(renewCount, 1);
  assert.equal(authCount > 0, true);
  assert.equal(runtime.snapshot().phase, 'online');
  runtime.disconnect();
  expiry = 900000;
  storedPairs = [];
  relayRead = null;
});

test('late token refresh cannot authenticate or restore a retired socket', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  storedPairs = [{ pairId: 'p_first', relay: TEST_RELAY }];
  relayRead = Promise.resolve({ pairs: [{ pair: 'p_first', joined: true, peerOnline: true }] });
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  const gate = deferred();
  authCount = 0;
  tokenRead = gate.promise;
  t.mock.timers.tick(600000);
  await Promise.resolve();
  runtime.disconnect();
  gate.resolve('token');
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.notEqual(runtime.snapshot().phase, 'online');
  assert.equal(authCount, 0);
  tokenRead = null;
  storedPairs = [];
  relayRead = null;
});

test('snapshot omits private pair material and is detached from vault data', async () => {
  storedPairs = [{ pairId: 'p_first', macId: 'mac', relay: TEST_RELAY, tx: { chain: 'secret' } }];
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  const snapshot = runtime.snapshot();
  assert.deepEqual(snapshot.pairs, [{ pairId: 'p_first', macId: 'mac' }]);
  snapshot.pairs[0].macId = 'changed';
  assert.equal(runtime.snapshot().pairs[0].macId, 'mac');
  storedPairs = [];
});

test('pair commit finishing after disconnect cannot publish a retired pair', async () => {
  storedPairs = [{ pairId: 'p_first', macId: 'mac', relay: TEST_RELAY }];
  relayRead = Promise.resolve({ pairs: [{ pair: 'p_first', joined: true, peerOnline: true }] });
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  const gate = deferred();
  finishGate = gate.promise;
  pairingStatus = 'waiting';
  relayOptions.onFrame({
    pair: 'p_12345678',
    dir: 'm2p',
    ctr: 0,
    nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    box: 'AAAAAAAAAAAAAAAAAAAAAA==',
  });
  await Promise.resolve();
  runtime.disconnect();
  gate.resolve({ pairId: 'p_new' });
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(runtime.snapshot().selectedPair, null);
  assert.notEqual(runtime.snapshot().phase, 'ready');
  pairingStatus = 'idle';
  finishGate = null;
  storedPairs = [];
  relayRead = null;
});

test('missing account and non-error storage failures produce bounded UI state', async () => {
  account = null;
  const signedOut = createMobileRuntime(TEST_RELAY);
  await signedOut.start();
  assert.equal(signedOut.snapshot().phase, 'signedOut');
  assert.equal(signedOut.snapshot().user, null);
  account = { user: { id: 'user' } };
  storageFailure = 'unavailable';
  const broken = createMobileRuntime(TEST_RELAY);
  await broken.start();
  assert.equal(broken.snapshot().error, 'Operation failed');
  storageFailure = null;
});

test('foreground reconnects one dropped socket and subscription cleanup removes its listener', async () => {
  storedPairs = [{ pairId: 'p_first', macId: 'mac', relay: TEST_RELAY }];
  relayRead = Promise.resolve({ pairs: [{ pair: 'p_first', joined: true, peerOnline: true }] });
  const runtime = createMobileRuntime(TEST_RELAY),
    off = runtime.subscribe(() => {});
  await runtime.start();
  await runtime.connect('p_first');
  relayOptions.onClose();
  assert.equal(runtime.snapshot().phase, 'offline');
  const before = sockets;
  foreground?.();
  foreground?.();
  for (let i = 0; i < 15; i++) await Promise.resolve();
  assert.equal(sockets, before + 1);
  assert.equal(runtime.snapshot().phase, 'online');
  const cleanups = foregroundCleanups;
  off();
  assert.equal(foregroundCleanups, cleanups + 1);
  assert.equal(foreground, null);
  runtime.disconnect();
  storedPairs = [];
  relayRead = null;
});

test('failed foreground retry is visible and does not remain busy', async () => {
  storedPairs = [{ pairId: 'p_first', macId: 'mac', relay: TEST_RELAY }];
  relayRead = Promise.resolve({ pairs: [{ pair: 'p_first', joined: true, peerOnline: true }] });
  const runtime = createMobileRuntime(TEST_RELAY),
    off = runtime.subscribe(() => {});
  await runtime.start();
  await runtime.connect('p_first');
  relayOptions.onClose();
  relayRead = Promise.resolve({ pairs: [] });
  foreground?.();
  for (let i = 0; i < 15; i++) await Promise.resolve();
  assert.equal(runtime.snapshot().phase, 'error');
  off();
  runtime.disconnect();
  storedPairs = [];
  relayRead = null;
});

test('reply and send failures without error objects use safe messages', async () => {
  storedPairs = [{ pairId: 'p_first', macId: 'mac', relay: TEST_RELAY }];
  relayRead = Promise.resolve({ pairs: [{ pair: 'p_first', joined: true, peerOnline: true }] });
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  const reply = runtime.request('chat.list', {});
  sessionOptions.onMessage({ kind: 'reply', inReplyTo: '00000000-0000-4000-8000-000000000000', ok: false });
  await assert.rejects(reply, /Request failed/);
  sendError = 'secret';
  await assert.rejects(runtime.request('chat.list', {}), /Send failed/);
  sendError = null;
  runtime.disconnect();
  storedPairs = [];
  relayRead = null;
});

test('late account restoration cannot publish after disconnect', async () => {
  const gate = deferred();
  restoreGate = gate.promise;
  const runtime = createMobileRuntime(TEST_RELAY);
  const start = runtime.start();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  runtime.disconnect();
  gate.resolve({ user: { id: 'old' } });
  await start;
  assert.equal(runtime.snapshot().user, null);
  restoreGate = null;
});

test('late account installation cannot publish after sign-out', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  const gate = deferred();
  installGate = gate.promise;
  const signIn = runtime.signIn();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await runtime.signOut();
  gate.resolve(null);
  await assert.rejects(signIn, /cancelled/);
  assert.equal(runtime.snapshot().user, null);
  installGate = null;
});

test('an old draining callback cannot consume the replacement inbox', async () => {
  storedPairs = [{ pairId: 'p_first', macId: 'mac', relay: TEST_RELAY }];
  relayRead = Promise.resolve({ pairs: [{ pair: 'p_first', joined: true, peerOnline: true }] });
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  const old = deferred();
  receiveGate = old.promise;
  receives = 0;
  relayOptions.onFrame({ pair: 'p_first', ctr: 1 });
  await Promise.resolve();
  runtime.disconnect();
  await runtime.connect('p_first');
  const current = deferred();
  receiveGate = current.promise;
  relayOptions.onFrame({ pair: 'p_first', ctr: 2 });
  relayOptions.onFrame({ pair: 'p_first', ctr: 3 });
  await Promise.resolve();
  assert.equal(receives, 2);
  old.resolve(null);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(receives, 2);
  current.resolve(null);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(receives, 3);
  receiveGate = null;
  runtime.disconnect();
  storedPairs = [];
  relayRead = null;
});

test('sign-in invalidated during startup or install-id read cannot open the browser', async () => {
  const first = createMobileRuntime(TEST_RELAY);
  const startup = deferred();
  restoreGate = startup.promise;
  const start = first.start();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  const signing = first.signIn();
  first.disconnect();
  startup.resolve(account);
  await start;
  await assert.rejects(signing, /cancelled/);
  restoreGate = null;
  const second = createMobileRuntime(TEST_RELAY);
  await second.start();
  const gate = deferred();
  installIdGate = gate.promise;
  const pending = second.signIn();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  second.disconnect();
  gate.resolve('install');
  await assert.rejects(pending, /cancelled/);
  installIdGate = null;
});

test('unexpected and short pairing frames do not interrupt a connected pair', async () => {
  storedPairs = [{ pairId: 'p_first', macId: 'mac', relay: TEST_RELAY }];
  relayRead = Promise.resolve({ pairs: [{ pair: 'p_first', joined: true, peerOnline: true }] });
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  const frame = { pair: 'p_12345678', dir: 'm2p', ctr: 0, nonce: 'AA==', box: 'AAAAAAAAAAAAAAAAAAAAAA==' };
  pairingStatus = 'idle';
  relayOptions.onFrame(frame);
  await Promise.resolve();
  pairingStatus = 'waiting';
  relayOptions.onFrame(frame);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(runtime.snapshot().phase, 'online');
  pairingStatus = 'idle';
  runtime.disconnect();
  storedPairs = [];
  relayRead = null;
});
