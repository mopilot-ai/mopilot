// Account-wide relay traffic retires only its exact selected, joining or loaded phone pair.
import assert from 'node:assert/strict';
import { TEST_RELAY } from './support/phone/testRelay.ts';
import { mock, test } from 'node:test';
import { withRelay } from './support/phoneAuthFake.ts';

const runtimeModulePath = '../mobile/src/runtime.ts';
const pairs = ['p_first000', 'p_second00'].map((pairId) => ({ pairId, macId: pairId, relay: TEST_RELAY }));
let relayOptions: any;
const sessions = new Map<string, any>();
const receives = new Map<string, () => Promise<void>>();
let pairingStatus = 'idle';
let savedPair = false,
  pendingPair = false;
let commitGate: Promise<void> | null = null;
let commitFailure: Error | null = null;
let joinGate: Promise<void> | null = null;
let pairAttempt: object | null = null;
/** Runs as the relay's hello arrives, before the runtime's connect resumes (React Native can deliver the next socket message in the same batch). */
let onHello: (() => void) | null = null;
let pairReadError: Error | null = null;
mock.module('../mobile/src/platform/crypto.ts', { namedExports: { phonePrimitives: () => ({ randomBytes: () => new Uint8Array(16) }) } });
mock.module('../mobile/src/platform/lifecycle.ts', { namedExports: { onForeground: () => () => {} } });
mock.module('../mobile/src/platform/auth.ts', { namedExports: { authorize: async () => ({}), refresh: async () => ({}) } });
mock.module('../mobile/src/platform/vault.ts', { namedExports: { openVaultStorage: async () => ({}) } });
mock.module('../shared/remote/phoneVault.mjs', {
  namedExports: {
    createPhoneVault: () => ({
      pairs: async () => {
        if (pairReadError) throw pairReadError;
        return savedPair ? [...pairs, { pairId: 'p_joining0', macId: 'new-mac' }] : pairs;
      },
      getPending: async () => (pendingPair ? { pairId: 'p_joining0' } : null),
      getPair: async (id: string) => pairs.find((p) => p.pairId === id),
      removePair: async () => false,
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
    createPhonePairing: (o: any) => ({
      status: () => pairingStatus,
      cancel: () => {
        pairAttempt = null;
        pairingStatus = 'idle';
      },
      begin: async () => {
        const attempt = {};
        pairAttempt = attempt;
        pairingStatus = 'starting';
        pendingPair = true;
        await o.transport.join(TEST_RELAY, 'p_joining0');
        if (pairAttempt !== attempt) throw new Error('pairing cancelled');
        pairingStatus = 'waiting';
        return { pairId: 'p_joining0', safetyNumber: '123456' };
      },
      finish: async () => {
        pairingStatus = 'committing';
        if (commitGate) await commitGate;
        if (commitFailure) {
          pairingStatus = 'idle';
          throw commitFailure;
        }
        savedPair = true;
        pendingPair = false;
        pairingStatus = 'idle';
        return { pairId: 'p_joining0' };
      },
    }),
  },
});
mock.module('../shared/remote/phoneRelay.mjs', {
  namedExports: {
    createPhoneRelay: (o: any) => {
      relayOptions = o;
      return {
        close() {},
        join: async () => {
          if (joinGate) await joinGate;
        },
        connect: async () => {
          const hello = { pairs: pairs.map((p) => ({ pair: p.pairId, joined: true, peerOnline: true, presence: 'online' })) };
          onHello?.();
          return hello;
        },
      };
    },
  },
});
mock.module('../shared/remote/phoneSession.mjs', {
  namedExports: {
    createPhoneSession: (o: any) => {
      const session = {
        options: o,
        closed: false,
        sent: [] as any[],
        close() {
          session.closed = true;
        },
        send: async (message: any) => {
          session.sent.push(message);
        },
        receive: async () => {
          await receives.get(o.pairId)?.();
        },
      };
      sessions.set(o.pairId, session);
      return session;
    },
  },
});
const { createMobileRuntime } = await import(runtimeModulePath);
async function setup() {
  sessions.clear();
  receives.clear();
  pairingStatus = 'idle';
  savedPair = false;
  pendingPair = false;
  commitGate = null;
  commitFailure = null;
  joinGate = null;
  pairAttempt = null;
  pairReadError = null;
  const runtime = createMobileRuntime(TEST_RELAY);
  await runtime.start();
  return runtime;
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const reply = {
  pair: 'p_joining0',
  dir: 'm2p',
  ctr: 0,
  nonce: Buffer.alloc(24).toString('base64'),
  box: Buffer.alloc(16).toString('base64'),
};

test('a retired commit failure reconciles and reports a still-owned storage read failure', async () => {
  const runtime = await setup();
  let release!: () => void;
  commitGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  commitFailure = new Error('commit failed');
  try {
    await runtime.pair('{}', 'Phone');
    relayOptions.onFrame(reply);
    await tick();
    relayOptions.onEvent({ ev: 'pair.removed', pair: 'p_joining0' });
    pairReadError = new Error('pair storage unavailable');
    release();
    await tick();
    assert.equal(runtime.snapshot().phase, 'error');
    assert.match(runtime.snapshot().error!, /pair storage unavailable/);
    assert.equal(runtime.snapshot().pairCleanup, true);
  } finally {
    release();
    runtime.disconnect();
  }
});

test('an active commit stays in progress instead of offering cleanup', async () => {
  const runtime = await setup();
  let release!: () => void;
  commitGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await runtime.pair('{}', 'Phone');
    relayOptions.onFrame(reply);
    await tick();
    assert.equal(pairingStatus, 'committing');
    const active = runtime.snapshot() as ReturnType<typeof runtime.snapshot> & { pairingCommit?: boolean };
    assert.equal(active.pairingCommit, true);
    assert.equal(active.pairCleanup, false);
    assert.equal(active.safetyNumber, '123456');
    release();
    await tick();
    assert.equal((runtime.snapshot() as typeof active).pairingCommit, false);
    assert.equal(runtime.snapshot().pendingPair, false);
  } finally {
    release();
    runtime.disconnect();
  }
});

for (const interruption of ['pair.removed', 'mailbox.dropped', 'disconnect', 'socket.close']) {
  test(`${interruption} after begin returns replaces confirmation with the cleanup action`, async () => {
    const runtime = await setup();
    try {
      await runtime.pair('{}', 'Phone');
      assert.equal(runtime.snapshot().pendingPair, true);
      assert.equal(runtime.snapshot().pairCleanup, false);
      assert.equal(runtime.snapshot().safetyNumber, '123456');
      if (interruption === 'disconnect') runtime.disconnect();
      else if (interruption === 'socket.close') relayOptions.onClose();
      else relayOptions.onEvent({ ev: interruption, pair: 'p_joining0' });
      assert.equal(runtime.snapshot().pendingPair, true);
      assert.equal(runtime.snapshot().pairCleanup, true);
      assert.equal(runtime.snapshot().safetyNumber, null);
    } finally {
      runtime.disconnect();
    }
  });
}

test('snapshot projections preserve the runtime-owned identity and pair list', async () => {
  const runtime = await setup();
  try {
    const copy = runtime.snapshot();
    copy.user!.id = 'forged';
    copy.pairs[0].pairId = 'forged';
    assert.equal(runtime.snapshot().user!.id, 'user');
    assert.equal(runtime.snapshot().pairs[0].pairId, 'p_first000');
  } finally {
    runtime.disconnect();
  }
});

test('retirement after reconciliation cannot install a stale paired channel', async () => {
  const runtime = await setup();
  let queued = false;
  const unsubscribe = runtime.subscribe(() => {
    if (!queued && runtime.snapshot().pairs.some((p) => p.pairId === 'p_joining0')) {
      assert.equal(runtime.snapshot().pairingCommit, true);
      queued = true;
      queueMicrotask(() => queueMicrotask(() => runtime.disconnect()));
    }
  });
  try {
    await runtime.pair('{}', 'Phone');
    relayOptions.onFrame(reply);
    await tick();
    assert.equal(queued, true);
    assert.equal(runtime.snapshot().phase, 'offline');
    assert.equal(sessions.has('p_joining0'), false);
  } finally {
    unsubscribe();
    runtime.disconnect();
  }
});

for (const replacement of [false, true])
  for (const interruption of ['pair.removed', 'mailbox.dropped', 'disconnect']) {
    test(`${interruption} before join completes exposes cleanup ${replacement ? 'while a replacement remains connected' : 'after retirement'}`, async () => {
      const runtime = await setup();
      let release!: () => void;
      joinGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        const attempt = runtime.pair('{}', 'Phone').then(
          () => null,
          (error) => error,
        );
        await tick();
        assert.equal(pairingStatus, 'starting');
        assert.equal(runtime.snapshot().pendingPair, false);
        if (interruption === 'disconnect') runtime.disconnect();
        else relayOptions.onEvent({ ev: interruption, pair: 'p_joining0' });
        if (replacement) await runtime.connect('p_first000');
        const retired = runtime.snapshot();
        release();
        assert.match((await attempt).message, /cancelled/);
        assert.equal(runtime.snapshot().pendingPair, true);
        assert.equal(runtime.snapshot().pairCleanup, true);
        assert.equal(runtime.snapshot().phase, retired.phase);
        assert.equal(runtime.snapshot().error, retired.error);
        assert.equal(runtime.snapshot().generation, retired.generation);
      } finally {
        release();
        runtime.disconnect();
      }
    });
  }

test('a retired commit refresh cannot turn a replacement connection into an error', async () => {
  const runtime = await setup();
  let release!: () => void;
  commitGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await runtime.pair('{}', 'Phone');
    relayOptions.onFrame(reply);
    await tick();
    assert.equal(pairingStatus, 'committing');
    relayOptions.onEvent({ ev: 'pair.removed', pair: 'p_joining0' });
    await runtime.connect('p_first000');
    const replacement = runtime.snapshot();
    pairReadError = new Error('old reconciliation failed');
    release();
    await tick();
    assert.equal(runtime.snapshot().phase, 'online');
    assert.equal(runtime.snapshot().selectedPair, 'p_first000');
    assert.equal(runtime.snapshot().generation, replacement.generation);
    assert.equal(runtime.snapshot().error, replacement.error);
    assert.equal(sessions.get('p_first000').closed, false);
  } finally {
    release();
    runtime.disconnect();
  }
});

for (const ev of ['pair.removed', 'mailbox.dropped']) {
  test(`${ev} during commit refreshes durable pair state without clearing the interruption`, async () => {
    const runtime = await setup();
    let release!: () => void;
    commitGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await runtime.pair('{}', 'Phone');
      relayOptions.onFrame(reply);
      await tick();
      assert.equal(pairingStatus, 'committing');
      relayOptions.onEvent({ ev, pair: 'p_joining0' });
      const retired = runtime.snapshot();
      assert.equal(retired.phase, 'error');
      assert.equal(retired.pendingPair, true);
      release();
      await tick();
      assert.equal(runtime.snapshot().phase, 'error');
      assert.equal(runtime.snapshot().error, retired.error);
      assert.equal(runtime.snapshot().generation, retired.generation);
      assert.equal(runtime.snapshot().pendingPair, false);
      assert.equal(runtime.snapshot().pairCleanup, false);
      assert.ok(runtime.snapshot().pairs.some((p) => p.pairId === 'p_joining0'));
    } finally {
      release();
      runtime.disconnect();
    }
  });
}

for (const ev of ['pair.removed', 'mailbox.dropped']) {
  test(`${ev} for another computer preserves the selected pair and its pending request`, async () => {
    const runtime = await setup();
    try {
      await runtime.connect('p_first000');
      const selected = sessions.get('p_first000');
      const other = sessions.get('p_second00');
      const generation = runtime.snapshot().generation;
      const answer = runtime.request('recent', {}).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await tick();
      relayOptions.onEvent({ ev, pair: 'p_second00' });
      assert.equal(runtime.snapshot().phase, 'online');
      assert.equal(runtime.snapshot().selectedPair, 'p_first000');
      assert.equal(runtime.snapshot().generation, generation);
      assert.equal(selected.closed, false);
      assert.equal(other.closed, true);
      selected.options.onMessage({ kind: 'reply', inReplyTo: selected.sent[0].id, ok: true, result: 'still connected' });
      assert.deepEqual(await answer, { value: 'still connected' });
    } finally {
      runtime.disconnect();
    }
  });

  test(`${ev} for the selected computer still interrupts and rejects its pending request`, async () => {
    const runtime = await setup();
    try {
      await runtime.connect('p_first000');
      const answer = runtime.request('recent', {}).then(
        () => null,
        (error) => error,
      );
      relayOptions.onEvent({ ev, pair: 'p_first000' });
      assert.equal(runtime.snapshot().phase, 'error');
      assert.match((await answer).message, /closed/);
    } finally {
      runtime.disconnect();
    }
  });

  test(`${ev} interrupts only the exact joining pair`, async () => {
    const runtime = await setup();
    try {
      await runtime.pair('{}', 'Phone');
      relayOptions.onEvent({ ev, pair: 'p_second00' });
      assert.equal(runtime.snapshot().phase, 'pairing');
      assert.equal(runtime.snapshot().safetyNumber, '123456');
      relayOptions.onEvent({ ev, pair: 'p_joining0' });
      assert.equal(runtime.snapshot().phase, 'error');
    } finally {
      runtime.disconnect();
    }
  });
}

test('malformed, unknown and online presence notifications cannot retire the selected connection', async () => {
  const runtime = await setup();
  try {
    await runtime.connect('p_first000');
    for (const event of [
      null,
      [],
      {},
      { ev: 'pair.removed' },
      { ev: 'mailbox.dropped', pair: [] },
      { ev: 'pair.removed', pair: 'unknown' },
      { ev: 'machine.presence', pair: 'p_first000' },
      { ev: 'machine.presence', pair: 'p_first000', state: 'unexpected' },
      { ev: 'machine.presence', pair: 'p_first000', state: 'online' },
      { ev: 'machine.presence', pair: 'p_second00', state: 'gone' },
    ]) {
      relayOptions.onEvent(event);
      assert.equal(runtime.snapshot().phase, 'online', JSON.stringify(event));
    }
    relayOptions.onEvent({ ev: 'machine.presence', pair: 'p_first000', state: 'sleeping' });
    assert.equal(runtime.snapshot().phase, 'offline');
  } finally {
    runtime.disconnect();
  }
});

test('a computer that goes away as the hello arrives stays away: the stale hello neither shows it online nor connects (#3248)', async () => {
  const runtime = await setup();
  try {
    onHello = () => relayOptions.onEvent({ ev: 'machine.presence', pair: 'p_first000', state: 'gone', at: 500 });
    await assert.rejects(runtime.connect('p_first000'), /offline/);
    const snap = runtime.snapshot();
    assert.notEqual(snap.phase, 'online');
    assert.deepEqual(snap.presence.p_first000, { state: 'gone', lastSeen: 500 });
    assert.equal(snap.presence.p_second00.state, 'online', 'a pair no event spoke for follows the hello');
    // the next connect, with no event on the way, takes the hello again
    onHello = null;
    await runtime.connect('p_first000');
    assert.equal(runtime.snapshot().phase, 'online');
    assert.equal(runtime.snapshot().presence.p_first000.state, 'online');
  } finally {
    onHello = null;
    runtime.disconnect();
  }
});

test('a failed inactive receive and an unknown frame leave the selected computer online', async () => {
  const runtime = await setup();
  try {
    await runtime.connect('p_first000');
    const inactive = sessions.get('p_second00');
    receives.set('p_second00', async () => {
      throw new Error('retired ratchet');
    });
    relayOptions.onFrame({ pair: 'p_second00', ctr: 1 });
    await tick();
    assert.equal(inactive.closed, true);
    assert.equal(runtime.snapshot().phase, 'online');
    relayOptions.onFrame({ pair: 'unknown', ctr: 1 });
    await tick();
    assert.equal(runtime.snapshot().phase, 'online');
    receives.set('p_first000', async () => {
      throw new Error('active receive failed');
    });
    relayOptions.onFrame({ pair: 'p_first000', ctr: 1 });
    await tick();
    assert.equal(runtime.snapshot().phase, 'error');
    assert.match(runtime.snapshot().error!, /active receive failed/);
  } finally {
    runtime.disconnect();
  }
});

test('an old inactive receive failure cannot close a replacement channel', async () => {
  const runtime = await setup();
  let reject!: (error: Error) => void;
  const gate = new Promise<void>((_resolve, no) => {
    reject = no;
  });
  try {
    await runtime.connect('p_first000');
    receives.set('p_second00', () => gate);
    relayOptions.onFrame({ pair: 'p_second00', ctr: 1 });
    await tick();
    await runtime.connect('p_first000');
    const replacement = sessions.get('p_second00');
    reject(new Error('old receive failed'));
    await tick();
    assert.equal(runtime.snapshot().phase, 'online');
    assert.equal(replacement.closed, false);
  } finally {
    runtime.disconnect();
  }
});
