// Runtime routing loads every pair before opening the relay and retires pending requests on disconnect.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { TEST_RELAY, withRelay } from './support/phoneAuthFake.ts';
const runtimeModulePath = '../mobile/src/runtime.ts';

const sessions = new Map<string, any>();
let openStorage: () => Promise<any> = async () => ({});
let relayOptions: any,
  relayConnected = false;
let online = true;
let joined = true;
let failAuthorize = false,
  failPair = false;
let failSend = false,
  failRefresh = false;
let finishError: Error | null = null;
let sendGate: Promise<void> | null = null;
let authorizeGate: Promise<void> | null = null;
let usePairTransport = false,
  joinCount = 0;
let refreshError: Error = new Error('refresh failed');
let lastPair: string | null = null,
  lastPairFails = false;
const savedLastPairs: Array<string | null> = [];
let refreshes = 0,
  authenticated = 0;
const pairs = [
  { pairId: 'p_first', macId: 'mac1', relay: TEST_RELAY },
  { pairId: 'p_second', macId: 'mac2', relay: TEST_RELAY },
];
mock.module('../mobile/src/platform/crypto.ts', { namedExports: { phonePrimitives: () => ({ randomBytes: () => new Uint8Array(16) }) } });
mock.module('../mobile/src/platform/lifecycle.ts', { namedExports: { onForeground: () => () => {} } });
mock.module('../mobile/src/platform/auth.ts', {
  namedExports: {
    authorize: async () => {
      if (authorizeGate) await authorizeGate;
      if (failAuthorize) throw new Error('authorization failed');
      return { user: { id: 'new-user' } };
    },
    refresh: async () => ({}),
  },
});
mock.module('../mobile/src/platform/vault.ts', { namedExports: { openVaultStorage: () => openStorage() } });
mock.module('../shared/remote/phoneVault.mjs', {
  namedExports: {
    createPhoneVault: () => ({
      pairs: async () => pairs,
      getPending: async () => null,
      claimCleanup: async () => null,
      getPair: async (id: string) => pairs.find((p) => p.pairId === id),
      removePair: async () => false,
      getInstallId: async () => 'install',
      getLastPair: async () => {
        if (lastPairFails) throw new Error('vault unreadable');
        return lastPair;
      },
      setLastPair: async (id: string | null) => {
        savedLastPairs.push(id);
        lastPair = id;
      },
    }),
  },
});
mock.module('../shared/remote/phoneAuth.mjs', {
  namedExports: {
    createPhoneAuth: () =>
      withRelay({
        restore: async () => ({ user: { id: 'user' } }),
        token: async (force: boolean) => {
          if (force) {
            refreshes++;
            if (failRefresh) throw refreshError;
          }
          return 'token';
        },
        expiresAt: () => Date.now() + 900000,
        signOut: async () => {},
        install: async () => {},
      }),
  },
});
mock.module('../shared/remote/phonePairing.mjs', {
  namedExports: {
    createPhonePairing: (options: any) => ({
      status: () => 'waiting',
      cancel: () => {},
      begin: async () => {
        if (failPair) throw new Error('pairing failed');
        if (usePairTransport) {
          await options.transport.join(TEST_RELAY, 'p_new');
          await options.transport.send({});
        }
        return { safetyNumber: '123456' };
      },
      finish: async () => {
        if (finishError) throw finishError;
        return { pairId: 'p_new' };
      },
    }),
  },
});
mock.module('../shared/remote/phoneSession.mjs', {
  namedExports: {
    createPhoneSession: (options: any) => {
      const session = {
        options,
        received: [] as any[],
        sent: [] as any[],
        close() {},
        send: async (message: any) => {
          session.sent.push(message);
          if (sendGate) await sendGate;
          if (failSend) throw new Error('send failed');
        },
        receive: async (frame: any) => {
          session.received.push(frame);
        },
      };
      sessions.set(options.pairId, session);
      return session;
    },
  },
});
mock.module('../shared/remote/phoneRelay.mjs', {
  namedExports: {
    createPhoneRelay: (options: any) => {
      relayOptions = options;
      return {
        close() {},
        connect: async () => {
          assert.equal(sessions.size, 2);
          relayConnected = true;
          return { pairs: [{ pair: 'p_first', joined, peerOnline: online }] };
        },
        send: async () => {},
        join: async () => {
          joinCount++;
        },
        authenticate: async () => {
          authenticated++;
        },
      };
    },
  },
});
const { createMobileRuntime } = await import(runtimeModulePath);
test('routes inactive pair frames and disconnect rejects the current pending request', async () => {
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  assert.equal(relayConnected && !!runtime.direct, true); // the phone's own paths exist once the vault is open
  assert.throws(() => runtime.send('c', '', ['img'], [], undefined, ['file:///a.png']), /Update MoPilot.*attachment is kept/);
  relayOptions.onFrame({ pair: 'p_second', ctr: 1 });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sessions.get('p_second').received.length, 1);
  const before = runtime.snapshot().generation;
  const pending = runtime.request('chat.list', {});
  runtime.disconnect();
  await assert.rejects(pending, /closed/);
  assert.ok(runtime.snapshot().generation > before);
});

test('a late reply from a retired session cannot settle a replacement request', async () => {
  sessions.clear();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  const old = sessions.get('p_first');
  const earlier = runtime.request('chat.list', {});
  runtime.disconnect();
  await assert.rejects(earlier, /closed/);
  await runtime.connect('p_first');
  const replacement = sessions.get('p_first');
  const pending = runtime.request('chat.list', {});
  const id = '00000000-0000-4000-8000-000000000000';
  old.options.onMessage({ kind: 'reply', inReplyTo: id, ok: true, result: 'stale' });
  replacement.options.onMessage({ kind: 'reply', inReplyTo: id, ok: true, result: 'fresh' });
  assert.equal(await pending, 'fresh');
  runtime.disconnect();
});

test('start coalesces and sign-out invalidates a pending storage open', async () => {
  let release!: (value: any) => void;
  openStorage = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const runtime = createMobileRuntime(TEST_RELAY);
  const first = runtime.start();
  assert.equal(runtime.start(), first);
  const out = runtime.signOut();
  release({});
  await Promise.all([first, out]);
  assert.equal(runtime.snapshot().phase, 'signedOut');
  assert.equal(runtime.snapshot().user, null);
  openStorage = async () => ({});
});

test('request captures parameters and rejects a duplicate request identifier', async () => {
  sessions.clear();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  const params = { nested: { text: 'before' } };
  const first = runtime.request('chat.send', params);
  params.nested.text = 'after';
  assert.equal(sessions.get('p_first').sent[0].params.nested.text, 'before');
  await assert.rejects(runtime.request('chat.send', {}), /collision/);
  runtime.disconnect();
  await assert.rejects(first, /closed/);
});

test('renews relay authentication and cancels its timer on disconnect', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sessions.clear();
  refreshes = 0;
  authenticated = 0;
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  t.mock.timers.tick(600000);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(refreshes, 1);
  assert.equal(authenticated, 1);
  runtime.disconnect();
  t.mock.timers.tick(600000);
  assert.equal(refreshes, 1);
});

test('offline connection and unknown pair fail visibly', async () => {
  sessions.clear();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await assert.rejects(runtime.connect('missing'), /Unknown pair/);
  assert.equal(runtime.snapshot().phase, 'error');
  online = false;
  await assert.rejects(runtime.connect('p_first'), /offline/);
  // an unreachable computer is waited for, not a failure of the account or the pair
  assert.equal(runtime.snapshot().phase, 'offline');
  online = true;
  runtime.disconnect();
});

test('reply failure and request timeout are visible', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sessions.clear();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  const failed = runtime.request('chat.send', {});
  sessions
    .get('p_first')
    .options.onMessage({ kind: 'reply', inReplyTo: '00000000-0000-4000-8000-000000000000', ok: false, error: { message: 'denied' } });
  await assert.rejects(failed, /denied/);
  const expired = runtime.request('chat.send', {});
  t.mock.timers.tick(30000);
  await assert.rejects(expired, /timed out/);
  runtime.disconnect();
});

test('an unknown incoming pair is ignored while the selected computer going away fails visibly', async () => {
  sessions.clear();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  relayOptions.onFrame({ pair: 'unknown', ctr: 1 });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(runtime.snapshot().phase, 'online');
  relayOptions.onEvent({ ev: 'machine.presence', pair: 'p_first', state: 'gone' });
  assert.equal(runtime.snapshot().phase, 'offline');
});

test('subscriptions receive current events and can unsubscribe', async () => {
  sessions.clear();
  const runtime = createMobileRuntime(TEST_RELAY);
  let changes = 0;
  const received: any[] = [];
  const unsubscribe = runtime.subscribe(() => {
    changes++;
  });
  const unlisten = runtime.onEvent((event) => received.push(event));
  await runtime.start();
  await runtime.connect('p_first');
  const event = { id: 'event', t: 1, kind: 'event', ev: 'session.patch' };
  sessions.get('p_first').options.onMessage(event);
  assert.deepEqual(received, [event]);
  unlisten();
  unsubscribe();
  const count = changes;
  sessions.get('p_first').options.onMessage(event);
  runtime.disconnect();
  assert.equal(received.length, 1);
  assert.equal(changes, count);
});

test('a token refresh that fails on the network waits for the computer instead of ending the session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sessions.clear();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  failRefresh = true;
  refreshError = new TypeError('Network request failed');
  t.mock.timers.tick(600000);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(runtime.snapshot().phase, 'offline');
  assert.equal(runtime.snapshot().reconnect?.pairId, 'p_first');
  assert.match(runtime.snapshot().error ?? '', /Network request failed/);
  failRefresh = false;
  refreshError = new Error('refresh failed');
  runtime.disconnect();
  assert.equal(runtime.snapshot().reconnect, null);
});

test('a message is sent although it cannot be kept on the device', async () => {
  sessions.clear();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  const id = '00000000-0000-4000-8000-000000000000';
  runtime.send('c1', 'hi');
  const session = sessions.get('p_first');
  const answer = async (result: unknown) => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    session.options.onMessage({ kind: 'reply', inReplyTo: id, ok: true, result });
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  await answer({ capabilities: { sendId: true } });
  assert.deepEqual(
    session.sent.map((m: any) => [m.method, m.params.text, typeof m.params.sendId]),
    [
      ['machine.hello', undefined, 'undefined'],
      ['chat.send', 'hi', 'string'],
    ],
  );
  await answer({ sent: true });
  assert.deepEqual(runtime.snapshot().outbox, [], 'the vault cannot keep it and the message still went');
  runtime.disconnect();
});

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

test('a cold start connects to the computer used last, by itself, and remembers a connection made by a tap', async () => {
  sessions.clear();
  lastPair = 'p_first';
  savedLastPairs.length = 0;
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await settle();
  assert.equal(runtime.snapshot().phase, 'online');
  assert.equal(runtime.snapshot().selectedPair, 'p_first');
  assert.deepEqual(savedLastPairs, ['p_first']);
  lastPair = null;
  await runtime.connect('p_first');
  assert.equal(lastPair, 'p_first', 'a connection made by a tap is the one used last');
  runtime.disconnect();
  await settle();
  assert.equal(lastPair, null, 'leaving on purpose is not undone by the next launch');
  assert.equal(runtime.snapshot().phase, 'offline');
});

test('a cold start with nothing to resume, or with the app busy, does not connect', async () => {
  sessions.clear();
  lastPair = null;
  const none = createMobileRuntime(TEST_RELAY);
  await none.start();
  await settle();
  assert.equal(none.snapshot().phase, 'ready');
  assert.equal(none.snapshot().reconnect, null);
  lastPair = 'gone';
  const stale = createMobileRuntime(TEST_RELAY);
  await stale.start();
  await settle();
  assert.equal(stale.snapshot().phase, 'ready', 'a computer that is no longer paired is not resumed');
  assert.equal(lastPair, null, 'and is forgotten');
  lastPairFails = true;
  const unreadable = createMobileRuntime(TEST_RELAY);
  await unreadable.start();
  await settle();
  assert.equal(unreadable.snapshot().phase, 'ready', 'a vault that cannot say leaves the app waiting for a tap');
  lastPairFails = false;
  // the user connected before the saved computer was read: that connection stays
  lastPair = 'p_second';
  const busy = createMobileRuntime(TEST_RELAY);
  const started = busy.start();
  const tapped = started.then(() => busy.connect('p_first'));
  await tapped;
  await settle();
  assert.equal(busy.snapshot().selectedPair, 'p_first');
  busy.disconnect();
});

test('a cold start with the computer away waits for it with the usual backoff instead of failing', async () => {
  sessions.clear();
  lastPair = 'p_first';
  online = false;
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await settle();
  assert.equal(runtime.snapshot().phase, 'offline');
  assert.equal(runtime.snapshot().reconnect?.pairId, 'p_first');
  online = true;
  runtime.disconnect();
  assert.equal(runtime.snapshot().reconnect, null);
});

test('a computer the Mac removed while the app was closed shows its error once and is not tried at the next launch', async () => {
  sessions.clear();
  lastPair = 'p_first';
  joined = false;
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await settle();
  joined = true;
  assert.equal(runtime.snapshot().phase, 'error');
  assert.equal(runtime.snapshot().reconnect, null, 'waiting would not bring it back');
  assert.equal(lastPair, null);
  // a tap that meets the same removal says so but leaves the choice alone
  lastPair = 'p_first';
  joined = false;
  await assert.rejects(runtime.connect('p_first'), /offline/);
  joined = true;
  assert.equal(lastPair, 'p_first');
  runtime.disconnect();
});

test('signing out forgets the computer used last', async () => {
  sessions.clear();
  lastPair = 'p_first';
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await settle();
  await runtime.signOut();
  assert.equal(lastPair, null);
  lastPair = 'p_first';
  await runtime.signIn();
  assert.equal(lastPair, null, 'a new sign-in starts with no computer chosen');
});

test('sign-in and pairing present their real states and can be cancelled', async () => {
  sessions.clear();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.signIn();
  assert.equal(runtime.snapshot().user?.id, 'new-user');
  await runtime.pair('{}', 'Phone');
  assert.equal(runtime.snapshot().safetyNumber, '123456');
  await runtime.cancelPairing();
  assert.equal(runtime.snapshot().phase, 'offline');
  await runtime.signOut();
  assert.equal(runtime.snapshot().phase, 'signedOut');
});

test('pair reply installs its channel before the next frame is processed', async () => {
  sessions.clear();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  relayOptions.onFrame({
    pair: 'p_12345678',
    dir: 'm2p',
    ctr: 0,
    nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    box: 'AAAAAAAAAAAAAAAAAAAAAA==',
  });
  relayOptions.onFrame({ pair: 'p_new', ctr: 1 });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(sessions.get('p_new').received.length, 1);
  runtime.disconnect();
});

test('send and token refresh failures terminate visibly', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sessions.clear();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  failSend = true;
  await assert.rejects(runtime.request('chat.send', {}), /send failed/);
  failSend = false;
  failRefresh = true;
  t.mock.timers.tick(600000);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(runtime.snapshot().phase, 'error');
  assert.match(runtime.snapshot().error ?? '', /refresh failed/);
  failRefresh = false;
});

test('malformed pairing replies are ignored while storage errors surface', async () => {
  sessions.clear();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  finishError = new SyntaxError('bad json');
  relayOptions.onFrame({
    pair: 'p_12345678',
    dir: 'm2p',
    ctr: 0,
    nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    box: 'AAAAAAAAAAAAAAAAAAAAAA==',
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(runtime.snapshot().phase, 'online');
  finishError = new Error('storage failed');
  relayOptions.onFrame({
    pair: 'p_12345678',
    dir: 'm2p',
    ctr: 0,
    nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    box: 'AAAAAAAAAAAAAAAAAAAAAA==',
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(runtime.snapshot().phase, 'error');
  finishError = null;
});

test('pairing joins the trusted relay through authenticated transport', async () => {
  sessions.clear();
  usePairTransport = true;
  joinCount = 0;
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.pair('{}', 'Phone');
  assert.equal(joinCount, 1);
  runtime.disconnect();
  usePairTransport = false;
});

test('startup, sign-in and pairing failures surface', async () => {
  openStorage = async () => {
    throw new Error('vault failed');
  };
  const bad = createMobileRuntime(TEST_RELAY);
  await bad.start();
  assert.equal(bad.snapshot().phase, 'error');
  openStorage = async () => ({});
  sessions.clear();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  failAuthorize = true;
  await assert.rejects(runtime.signIn(), /authorization failed/);
  failAuthorize = false;
  failPair = true;
  await assert.rejects(runtime.pair('{}', 'Phone'), /pairing failed/);
  failPair = false;
  assert.equal(runtime.snapshot().phase, 'error');
});

test('relay revocation and close report a lost connection, malformed frames are ignored', async () => {
  sessions.clear();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  relayOptions.onFrame({ pair: 'bad', ctr: 0 });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(runtime.snapshot().phase, 'online');
  relayOptions.onEvent({ ev: 'pair.removed', pair: 'p_first' });
  assert.equal(runtime.snapshot().phase, 'error');
  sessions.clear();
  await runtime.connect('p_first');
  relayOptions.onClose();
  assert.equal(runtime.snapshot().phase, 'offline');
});

test('native socket uses a bearer header and encrypted send reaches the relay', async () => {
  sessions.clear();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  const previous = globalThis.WebSocket;
  let observed: any;
  globalThis.WebSocket = class {
    constructor(...args: any[]) {
      observed = args;
    }
  } as any;
  try {
    relayOptions.open(TEST_RELAY, 'secret');
    assert.equal(observed[2].headers.Authorization, 'Bearer secret');
    assert.ok(!observed[0].includes('secret'));
    await sessions.get('p_first').options.send({});
  } finally {
    globalThis.WebSocket = previous;
    runtime.disconnect();
  }
});

test('old send rejection cannot reject a replacement request with the same id', async () => {
  sessions.clear();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  let reject!: (error: Error) => void;
  sendGate = new Promise((_, fail) => {
    reject = fail;
  });
  const old = runtime.request('chat.send', {});
  runtime.disconnect();
  await assert.rejects(old, /closed/);
  sendGate = null;
  sessions.clear();
  await runtime.connect('p_first');
  const replacement = runtime.request('chat.send', {});
  reject(new Error('late send failed'));
  await Promise.resolve();
  await Promise.resolve();
  sessions.get('p_first').options.onMessage({ kind: 'reply', inReplyTo: '00000000-0000-4000-8000-000000000000', ok: true, result: 'ok' });
  assert.equal(await replacement, 'ok');
  runtime.disconnect();
});

test('a late browser sign-in cannot restore a signed-out account', async () => {
  sessions.clear();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  let release!: () => void;
  authorizeGate = new Promise((resolve) => {
    release = resolve;
  });
  const signIn = runtime.signIn();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await runtime.signOut();
  release();
  await assert.rejects(signIn, /cancelled/);
  assert.equal(runtime.snapshot().user, null);
  authorizeGate = null;
});

test('a malformed reply fails only its request; a malformed message with no request, or from a retired session, changes nothing', async () => {
  sessions.clear();
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.connect('p_first');
  const old = sessions.get('p_first');
  const phase = runtime.snapshot().phase;
  const doomed = runtime.request('chat.list', {});
  old.options.onMalformed({ inReplyTo: null });
  old.options.onMalformed({ inReplyTo: 'r_unknown' });
  old.options.onMalformed({ inReplyTo: old.sent[0].id });
  await assert.rejects(doomed, { code: 'reply_unreadable', message: 'The computer sent a reply this phone could not read' });
  assert.equal(runtime.snapshot().phase, phase);
  assert.equal(runtime.snapshot().error ?? null, null);
  // a session retired by a reconnect cannot fail the new session's request
  runtime.disconnect();
  await runtime.connect('p_first');
  const fresh = sessions.get('p_first');
  const next = runtime.request('chat.list', {});
  old.options.onMalformed({ inReplyTo: fresh.sent[0].id });
  fresh.options.onMessage({ kind: 'reply', inReplyTo: fresh.sent[0].id, ok: true, result: 'fine' });
  assert.equal(await next, 'fine');
  runtime.disconnect();
});
