// Pair cancellation waits for joining to settle, removes the relay pair, and commits cleanup conditionally.
import assert from 'node:assert/strict';
import { TEST_RELAY } from './support/phone/testRelay.ts';
import { mock, test } from 'node:test';
import { withRelay } from './support/phoneAuthFake.ts';
import { waitFor } from './support/waitFor.ts';
const runtimeModulePath = '../mobile/src/runtime.ts';
const deferred = () => {
  let resolve!: (v: any) => void;
  const promise = new Promise<any>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let finalReadGate: Promise<any> | null = null,
  holdFinalRead = false,
  finalReadEntered = false;
let pendingFails = false,
  failPendingOnJoin = false;
let joinError: Error | null = null,
  joinCalls = 0;
let pending: any = null,
  claim = 0,
  removeCalls = 0,
  removeError: Error | null = null,
  beginGate: Promise<any> | null = null;
let beginFailure: Error | null = null;
let pairingStatus = 'idle',
  joinOnBegin = false;
let claimOnBegin = false;
let relayOptions: any,
  expiryHook: (() => void) | null = null;
let blockedStage = '',
  stageEntered = '',
  stageGate: Promise<any> | null = null;
const gateStage = async (name: string) => {
  stageEntered = name;
  if (blockedStage === name && stageGate) await stageGate;
};
let storageFails = false,
  signInFails = false;
let restored: any = { user: { id: 'user' } };
mock.module('../mobile/src/platform/crypto.ts', { namedExports: { phonePrimitives: () => ({ randomBytes: () => new Uint8Array(16) }) } });
mock.module('../mobile/src/platform/lifecycle.ts', { namedExports: { onForeground: () => () => {} } });
mock.module('../mobile/src/platform/auth.ts', {
  namedExports: {
    authorize: async () => {
      if (signInFails) throw new Error('cancelled');
      return {};
    },
    refresh: async () => ({}),
  },
});
mock.module('../mobile/src/platform/vault.ts', {
  namedExports: {
    openVaultStorage: async () => {
      if (storageFails) throw new Error('vault failed');
      return {};
    },
  },
});
mock.module('../shared/remote/phoneVault.mjs', {
  namedExports: {
    createPhoneVault: () => ({
      pairs: async () => [],
      getInstallId: async () => 'install',
      claimPending: async (value: any) => {
        pending = value;
        return true;
      },
      getPending: async () => {
        if (holdFinalRead && finalReadGate) {
          finalReadEntered = true;
          await finalReadGate;
        }
        if (pendingFails) throw new Error('pending unavailable');
        return pending;
      },
      claimCleanup: async () => {
        await gateStage('claim');
        if (!pending) return null;
        pending = {
          ...pending,
          cleanupFrom: pending.phase === 'cleanup' ? pending.cleanupFrom : pending.phase,
          phase: 'cleanup',
          cleanupClaim: String(++claim),
        };
        return pending;
      },
      finishCleanup: async (owner: string) => {
        await gateStage('finish');
        if (owner !== pending?.cleanupClaim) throw new Error('stale');
        pending = null;
        if (finalReadGate) holdFinalRead = true;
      },
    }),
  },
});
mock.module('../shared/remote/phoneAuth.mjs', {
  namedExports: {
    createPhoneAuth: () =>
      withRelay({
        restore: async () => restored,
        signOut: async () => {},
        token: async () => 'token',
        expiresAt: () => {
          expiryHook?.();
          return Date.now() + 900000;
        },
      }),
  },
});
mock.module('../shared/remote/phonePairing.mjs', {
  namedExports: {
    createPhonePairing: (options: any) => ({
      status: () => pairingStatus,
      cancel: () => {
        pairingStatus = 'idle';
      },
      begin: async () => {
        pairingStatus = 'waiting';
        if (beginFailure) {
          holdFinalRead = true;
          throw beginFailure;
        }
        if (joinOnBegin) await options.transport.join(TEST_RELAY, 'p_12345678');
        if (beginGate) await beginGate;
        if (claimOnBegin)
          await options.store.claimPending({
            owner: 'local',
            pairId: 'p_12345678',
            relay: TEST_RELAY,
            phase: 'prepared',
          });
        return { safetyNumber: '123456' };
      },
      finish: async () => {
        pairingStatus = 'idle';
        pending = null;
        return { pairId: 'p_12345678' };
      },
    }),
  },
});
mock.module('../shared/remote/phoneSession.mjs', { namedExports: { createPhoneSession: () => ({ close() {} }) } });
mock.module('../shared/remote/phoneRelay.mjs', {
  namedExports: {
    createPhoneRelay: (options: any) => {
      relayOptions = options;
      return {
        close() {},
        connect: async () => {
          await gateStage('connect');
          return { pairs: [] };
        },
        join: async () => {
          await gateStage('join');
          joinCalls++;
          if (joinError) {
            if (failPendingOnJoin) pendingFails = true;
            throw joinError;
          }
        },
        remove: async () => {
          await gateStage('remove');
          removeCalls++;
          if (removeError) throw removeError;
        },
      };
    },
  },
});
const { createMobileRuntime } = await import(runtimeModulePath);

test('cleanup waits for the cancelled begin and only clears after relay acknowledgement', async () => {
  pending = { owner: 'a', pairId: 'p_12345678', relay: TEST_RELAY, phase: 'joining' };
  removeCalls = 0;
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  assert.equal(runtime.snapshot().pairCleanup, true);
  const gate = deferred();
  beginGate = gate.promise;
  const pair = runtime.pair('{}', 'Phone');
  await Promise.resolve();
  const cleanup = runtime.cancelPairing();
  await Promise.resolve();
  assert.equal(removeCalls, 0);
  gate.resolve({ safetyNumber: '123456' });
  await pair;
  await cleanup;
  assert.equal(removeCalls, 1);
  assert.equal(pending, null);
  assert.equal(runtime.snapshot().pendingPair, false);
  beginGate = null;
});

test('failed cleanup remains retryable and unknown pair is accepted', async () => {
  pending = { owner: 'a', pairId: 'p_12345678', relay: TEST_RELAY, phase: 'joining' };
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  removeError = new Error('relay: forbidden');
  await assert.rejects(runtime.cancelPairing(), /forbidden/);
  assert.equal(pending.phase, 'cleanup');
  removeError = new Error('relay: unknown_pair');
  await runtime.cancelPairing();
  assert.equal(pending, null);
  removeError = null;
});

test('failed startup is retryable', async () => {
  storageFails = true;
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  assert.equal(runtime.snapshot().phase, 'error');
  storageFails = false;
  await runtime.start();
  assert.equal(runtime.snapshot().phase, 'ready');
  assert.equal(runtime.snapshot().error, null);
});

test('retry after a failed browser sign-in returns to signed-out state', async () => {
  pending = null;
  restored = null;
  signInFails = true;
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await assert.rejects(runtime.signIn(), /cancelled/);
  assert.equal(runtime.snapshot().phase, 'error');
  await runtime.start();
  assert.equal(runtime.snapshot().phase, 'signedOut');
  restored = { user: { id: 'user' } };
  signInFails = false;
});

test('pairing times out visibly and leaves retryable cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  pending = { owner: 'a', pairId: 'p_12345678', relay: TEST_RELAY, phase: 'joining' };
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.pair('{}', 'Phone');
  assert.equal(runtime.snapshot().pairCleanup, false);
  pairingStatus = 'committing';
  t.mock.timers.tick(300000);
  assert.equal(runtime.snapshot().phase, 'pairing');
  pairingStatus = 'waiting';
  t.mock.timers.tick(1000);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(runtime.snapshot().pairCleanup, true);
  assert.match(runtime.snapshot().error ?? '', /timed out/);
});

test('prepared cleanup stays local and uncertain joins leave a notice', async () => {
  pending = { owner: 'a', pairId: 'p_12345678', relay: TEST_RELAY, phase: 'prepared' };
  joinCalls = 0;
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.cancelPairing();
  assert.equal(joinCalls, 0);
  assert.match(runtime.snapshot().error ?? '', /computer/);
  for (const code of ['unknown_pair', 'expired', 'taken']) {
    pending = { owner: 'a', pairId: 'p_12345678', relay: TEST_RELAY, phase: 'joining' };
    joinError = new Error(`relay: ${code}`);
    await runtime.cancelPairing();
    assert.equal(pending, null);
    assert.match(runtime.snapshot().error ?? '', /computer/);
  }
  joinError = null;
});

test('cleanup retirement prevents stale continuations at each external boundary', async () => {
  for (const stage of ['claim', 'connect', 'join', 'remove', 'finish']) {
    pending = { owner: 'a', pairId: 'p_12345678', relay: TEST_RELAY, phase: 'joining' };
    const runtime = createMobileRuntime(TEST_RELAY);
    await runtime.start();
    const gate = deferred();
    blockedStage = stage;
    stageEntered = '';
    stageGate = gate.promise;
    const cleanup = runtime.cancelPairing();
    await waitFor(() => !(stageEntered !== stage), 'the cleanup stage to be entered');
    assert.equal(stageEntered, stage);
    runtime.disconnect();
    gate.resolve(null);
    await assert.rejects(cleanup, /cancelled/);
    blockedStage = '';
    stageGate = null;
  }
});

test('cleanup coalesces repeated requests and blocks pairing until settled', async () => {
  pending = { owner: 'a', pairId: 'p_12345678', relay: TEST_RELAY, phase: 'joining' };
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  const gate = deferred();
  blockedStage = 'claim';
  stageGate = gate.promise;
  const first = runtime.cancelPairing(),
    second = runtime.cancelPairing();
  await assert.rejects(runtime.pair('{}', 'Phone'), /cleanup is in progress/);
  gate.resolve(null);
  await Promise.all([first, second]);
  blockedStage = '';
  stageGate = null;
});

test('cleanup rejects untrusted relay and malformed phase without clearing the claim', async () => {
  for (const input of [
    { relay: 'wss://other.example/v1/ws', phase: 'joining' },
    { relay: TEST_RELAY, phase: 'broken' },
  ]) {
    pending = { owner: 'a', pairId: 'p_12345678', ...input };
    const runtime = createMobileRuntime(TEST_RELAY);
    await runtime.start();
    await assert.rejects(runtime.cancelPairing(), /Untrusted|Invalid/);
    assert.equal(pending.phase, 'cleanup');
  }
});

test('join and removal errors other than known terminal outcomes remain retryable', async () => {
  pending = { owner: 'a', pairId: 'p_12345678', relay: TEST_RELAY, phase: 'joining' };
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  joinError = new Error('relay: forbidden');
  await assert.rejects(runtime.cancelPairing(), /forbidden/);
  assert.equal(pending.phase, 'cleanup');
  joinError = null;
});

test('storage failures during timeout or cleanup remain visible', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  pending = { owner: 'a', pairId: 'p_12345678', relay: TEST_RELAY, phase: 'joining' };
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.pair('{}', 'Phone');
  pendingFails = true;
  t.mock.timers.tick(300000);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.match(runtime.snapshot().error ?? '', /pending unavailable/);
  pendingFails = false;
  joinError = new Error('join failed');
  failPendingOnJoin = true;
  await assert.rejects(runtime.cancelPairing(), /pending unavailable/);
  assert.match(runtime.snapshot().error ?? '', /pending unavailable/);
  pendingFails = false;
  failPendingOnJoin = false;
  joinError = null;
});

test('successful pair reply cancels the waiting deadline', async () => {
  pending = { owner: 'a', pairId: 'p_12345678', relay: TEST_RELAY, phase: 'joining' };
  joinOnBegin = true;
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  await runtime.pair('{}', 'Phone');
  relayOptions.onFrame({
    pair: 'p_12345678',
    dir: 'm2p',
    ctr: 0,
    nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    box: 'AAAAAAAAAAAAAAAAAAAAAA==',
  });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(runtime.snapshot().pendingPair, false);
  runtime.disconnect();
  joinOnBegin = false;
});

test('cleanup is retired while waiting for begin or immediately after relay open', async () => {
  pending = { owner: 'a', pairId: 'p_12345678', relay: TEST_RELAY, phase: 'joining' };
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  const gate = deferred();
  beginGate = gate.promise;
  const pair = runtime.pair('{}', 'Phone');
  await Promise.resolve();
  const cleanup = runtime.cancelPairing();
  runtime.disconnect();
  gate.resolve({ safetyNumber: '123456' });
  await pair;
  await assert.rejects(cleanup, /cancelled/);
  beginGate = null;
  expiryHook = () => {
    expiryHook = null;
    queueMicrotask(() => runtime.disconnect());
  };
  await assert.rejects(runtime.cancelPairing(), /cancelled/);
});

test('a queued pairing deadline cannot affect a retired operation', async () => {
  const originalSet = globalThis.setTimeout,
    originalClear = globalThis.clearTimeout;
  const timers: Array<() => void> = [];
  globalThis.setTimeout = ((fn: () => void) => {
    timers.push(fn);
    return timers.length;
  }) as any;
  globalThis.clearTimeout = (() => {}) as any;
  try {
    pending = { owner: 'a', pairId: 'p_12345678', relay: TEST_RELAY, phase: 'joining' };
    const runtime = createMobileRuntime(TEST_RELAY);
    await runtime.start();
    await runtime.pair('{}', 'Phone');
    runtime.disconnect();
    timers.at(-1)?.();
    assert.notEqual(runtime.snapshot().phase, 'error');
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});

test('late cleanup final read cannot publish into a newer sign-out', async () => {
  pending = { owner: 'a', pairId: 'p_12345678', relay: TEST_RELAY, phase: 'prepared' };
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  const gate = deferred();
  finalReadGate = gate.promise;
  finalReadEntered = false;
  holdFinalRead = false;
  const cleanup = runtime.cancelPairing();
  await waitFor(() => finalReadEntered, 'the final read');
  assert.equal(finalReadEntered, true);
  const signOut = runtime.signOut();
  gate.resolve(null);
  await Promise.all([cleanup, signOut]);
  assert.equal(runtime.snapshot().phase, 'signedOut');
  assert.equal(runtime.snapshot().error, null);
  finalReadGate = null;
  holdFinalRead = false;
});

test('a late local pairing claim is selected for cancellation without adopting another owner', async () => {
  pending = null;
  claimOnBegin = true;
  const gate = deferred();
  beginGate = gate.promise;
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  const pair = runtime.pair('{}', 'Phone');
  await Promise.resolve();
  const cleanup = runtime.cancelPairing();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  gate.resolve(null);
  await pair;
  await cleanup;
  assert.equal(pending, null);
  beginGate = null;
  claimOnBegin = false;
});

test('late pair failure cannot replace a newer signed-out state', async () => {
  pending = null;
  restored = { user: { id: 'user' } };
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  const gate = deferred();
  finalReadGate = gate.promise;
  finalReadEntered = false;
  holdFinalRead = false;
  beginFailure = new Error('old pairing failed');
  const pair = runtime.pair('{}', 'Phone');
  const rejected = assert.rejects(pair, /old pairing failed/);
  await waitFor(() => finalReadEntered, 'the final read');
  assert.equal(finalReadEntered, true);
  const signOut = runtime.signOut();
  gate.resolve(null);
  await Promise.all([rejected, signOut]);
  assert.equal(runtime.snapshot().phase, 'signedOut');
  assert.equal(runtime.snapshot().error, null);
  beginFailure = null;
  finalReadGate = null;
  holdFinalRead = false;
});
