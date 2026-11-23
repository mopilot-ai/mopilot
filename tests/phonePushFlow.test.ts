// Phone push flow: token registration ordering, the permission explanation, single-flight drains and tap routing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPushRegistration } from '../mobile/src/push/registration';
import { createPermissionFlow, REASK_MS } from '../mobile/src/push/permission';
import { createWake } from '../mobile/src/push/wake';
import { locateTarget } from '../mobile/src/push/route';
import { chatRef } from '../mobile/src/push/chatRef';

const defer = <T = void>(): any => {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setImmediate(r));

function registrationRig(initial: string | null = null) {
  const calls: string[] = [];
  let token: string | null = 'tok1';
  let refresh: (() => void) | null = null;
  let stored = initial;
  const gate: { current: Promise<void> | null; fail: Error | null } = { current: null, fail: null };
  const reg = createPushRegistration({
    relay: {
      register: async (platform, t) => {
        calls.push(`register:${platform}:${t}`);
        await gate.current;
        if (gate.fail) throw gate.fail;
      },
      unregister: async () => {
        calls.push('unregister');
        await gate.current;
        if (gate.fail) throw gate.fail;
      },
    },
    tokens: { platform: 'fcm', get: async () => token, onRefresh: (l) => ((refresh = l), () => (refresh = null)) },
    store: { read: async () => stored, write: async (t) => void (stored = t) },
  });
  return {
    reg,
    calls,
    gate,
    setToken: (t: string | null) => (token = t),
    rotate: () => refresh?.(),
    subscribed: () => refresh !== null,
    stored: () => stored,
  };
}

test('enable registers once, a rotated token replaces it, an unchanged token is not resent', async () => {
  const r = registrationRig();
  await r.reg.enable();
  await r.reg.sync();
  assert.deepEqual(r.calls, ['register:fcm:tok1']);
  r.setToken('tok2');
  r.rotate();
  await tick();
  await r.reg.sync();
  assert.deepEqual(r.calls, ['register:fcm:tok1', 'register:fcm:tok2']);
  assert.equal(r.stored(), 'tok2');
  await r.reg.enable();
  assert.equal(r.calls.length, 2);
});

test('a token already registered before a restart is not sent again, and a missing token registers nothing', async () => {
  const r = registrationRig('tok1');
  await r.reg.enable();
  assert.deepEqual(r.calls, []);
  r.setToken(null);
  await r.reg.sync();
  assert.deepEqual(r.calls, []);
});

test('disable during an in-flight register is followed by an unregister, and rotations stop', async () => {
  const r = registrationRig();
  const hold = defer();
  r.gate.current = hold.promise;
  const enabling = r.reg.enable();
  await tick();
  const disabling = r.reg.disable();
  hold.resolve();
  await Promise.all([enabling, disabling]);
  assert.deepEqual(r.calls, ['register:fcm:tok1', 'unregister']);
  assert.equal(r.stored(), null);
  assert.equal(r.subscribed(), false);
  await r.reg.disable();
  assert.equal(r.calls.length, 2);
});

test('disable before the token resolves registers nothing', async () => {
  const r = registrationRig();
  const first = r.reg.enable();
  const second = r.reg.disable();
  await Promise.all([first, second]);
  assert.deepEqual(r.calls, []);
});

test('a failed relay call rejects, keeps the old state and is retried by the next sync', async () => {
  const r = registrationRig();
  r.gate.fail = new Error('relay: forbidden');
  await assert.rejects(r.reg.enable(), /forbidden/);
  assert.equal(r.stored(), null);
  r.gate.fail = null;
  await r.reg.sync();
  assert.deepEqual(r.calls, ['register:fcm:tok1', 'register:fcm:tok1']);
  r.gate.fail = new Error('offline');
  await assert.rejects(r.reg.disable(), /offline/);
  assert.equal(r.stored(), 'tok1');
  r.gate.fail = null;
  await r.reg.sync();
  assert.equal(r.stored(), null);
  r.rotate();
});

test('a rotation callback that fails is swallowed', async () => {
  const r = registrationRig();
  await r.reg.enable();
  r.gate.fail = new Error('x');
  r.setToken('tok9');
  r.rotate();
  await tick();
  assert.equal(r.stored(), 'tok1');
});

test('the permission flow explains first, asks the OS only on accept, and does not nag after Not now', async () => {
  let os: 'granted' | 'denied' | 'undetermined' = 'undetermined';
  let asked = 0;
  let dismissed: number | null = null;
  let now = 1_000;
  const flow = createPermissionFlow({
    port: { status: async () => os, request: async () => (asked++, (os = 'granted'), 'granted') },
    store: { read: async () => dismissed, write: async (v) => void (dismissed = v) },
    now: () => now,
  });
  assert.equal(await flow.step(), 'explain');
  assert.equal(asked, 0);
  await flow.dismiss();
  assert.equal(await flow.step(), 'later');
  now += REASK_MS;
  assert.equal(await flow.step(), 'explain');
  assert.equal(await flow.accept(), 'granted');
  assert.equal(dismissed, null);
  assert.equal(await flow.step(), 'granted');
  os = 'denied';
  assert.equal(await flow.step(), 'blocked');
  const defaults = createPermissionFlow({
    port: { status: async () => 'undetermined', request: async () => 'denied' },
    store: { read: async () => null, write: async () => {} },
  });
  assert.equal(await defaults.step(), 'explain');
});

test('wakes coalesce: one drain at a time, one more drain for any number of wakes during it, failures do not stick', async () => {
  const gates: Array<ReturnType<typeof defer>> = [];
  let runs = 0;
  const wake = createWake(async () => {
    runs++;
    const g = defer();
    gates.push(g);
    await g.promise;
    if (runs === 2) throw new Error('relay down');
  });
  const first = wake.wake();
  await tick();
  const second = wake.wake();
  const third = wake.wake();
  assert.equal(runs, 1);
  gates[0].resolve();
  await tick();
  assert.equal(runs, 2);
  gates[1].resolve();
  await Promise.all([first, second, third]);
  assert.equal(runs, 2);
  const again = wake.wake();
  await tick();
  assert.equal(runs, 3);
  gates[2].resolve();
  await again;
});

test('tap routing: the offline notice names its pair, a chat ref is searched across computers, unreachable computers are skipped', async () => {
  const payload = (kind: any, ref: string) => ({ kind, ref, count: 1 });
  const l = (over: any = {}) => ({ pairs: ['p_a', 'p_b'], chatIds: async () => [] as string[], current: () => true, ...over });
  assert.deepEqual(await locateTarget(payload('machineOffline', 'p_b'), l()), { pairId: 'p_b' });
  assert.equal(await locateTarget(payload('machineOffline', 'p_zzz'), l()), null);
  const ref = chatRef('p_b', 'chat-7');
  const asked: string[] = [];
  const found = await locateTarget(
    payload('needsYou', ref),
    l({
      chatIds: async (pair: string) => {
        asked.push(pair);
        if (pair === 'p_a') throw new Error('Computer is offline');
        return ['chat-1', 'chat-7'];
      },
    }),
  );
  assert.deepEqual(found, { pairId: 'p_b', chatId: 'chat-7' });
  assert.deepEqual(asked, ['p_a', 'p_b']);
  assert.equal(await locateTarget(payload('done', 'unknown-ref'), l({ chatIds: async () => ['chat-1'] })), null);
  assert.equal(await locateTarget(payload('done', ref), l({ chatIds: async () => ['chat-7'], current: () => false })), null);
  assert.equal(await locateTarget(payload('done', ref), l({ pairs: [] })), null);
});

test('forget during an unregister keeps the forgotten state', async () => {
  const r = registrationRig('tokX');
  const hold = defer();
  r.gate.current = hold.promise;
  const disabling = r.reg.disable();
  await tick();
  await r.reg.forget();
  hold.resolve();
  await disabling;
  assert.equal(r.stored(), null);
});

test('forget outlives an operation in flight and leaves nothing remembered', async () => {
  const r = registrationRig();
  const hold = defer();
  r.gate.current = hold.promise;
  const enabling = r.reg.enable();
  await tick();
  await r.reg.forget();
  hold.resolve();
  await enabling;
  assert.equal(r.stored(), null);
  r.gate.current = null;
  await r.reg.sync();
  assert.equal(r.calls.filter((c) => c.startsWith('register')).length, 2);
});

test('a forget during the store write has the last word in the store', async () => {
  const writes: Array<string | null> = [];
  const hold = defer();
  let first = true;
  const reg = createPushRegistration({
    relay: { register: async () => {}, unregister: async () => {} },
    tokens: { platform: 'fcm', get: async () => 'tokZ', onRefresh: () => () => {} },
    store: {
      read: async () => null,
      write: async (t) => {
        if (first && t) {
          first = false;
          await hold.promise;
        }
        writes.push(t);
      },
    },
  });
  const enabling = reg.enable();
  await tick();
  const forgetting = reg.forget();
  hold.resolve();
  await Promise.all([enabling, forgetting]);
  assert.equal(writes.at(-1), null);
});

test('the registration reports its token status: waiting, unavailable in this build, registered, and nothing once off', async () => {
  let token: string | null = null;
  let failure: string | null = null;
  const reg = createPushRegistration({
    relay: { register: async () => {}, unregister: async () => {} },
    tokens: {
      platform: 'apns',
      get: async () => token,
      get failure() {
        return failure;
      },
      onRefresh: () => () => {},
    },
    store: { read: async () => null, write: async () => {} },
  });
  const seen: Array<string | null> = [];
  const off = reg.onStatus((status) => seen.push(status));
  await reg.enable();
  assert.deepEqual(seen, ['waiting'], 'the OS has no token yet and did not refuse');
  await reg.sync();
  assert.deepEqual(seen, ['waiting'], 'an unchanged status is not announced again');
  failure = 'no valid aps-environment entitlement';
  await reg.sync();
  assert.deepEqual(seen, ['waiting', 'unavailable']);
  failure = null;
  token = 'tok-1';
  await reg.sync();
  assert.deepEqual(seen, ['waiting', 'unavailable', 'registered']);
  await reg.sync();
  assert.deepEqual(seen.at(-1), 'registered', 'the same token again stays registered');
  await reg.forget();
  assert.deepEqual(seen.at(-1), null, 'a forgotten token is no status');
  await reg.enable();
  assert.deepEqual(seen.at(-1), 'registered');
  await reg.disable();
  assert.deepEqual(seen.at(-1), null);
  off();
  const before = seen.length;
  await reg.enable();
  assert.equal(seen.length, before, 'a listener that stopped hears nothing');
  await reg.disable();
});

test('a registration that has no failure signal reads a missing token as waiting', async () => {
  const reg = createPushRegistration({
    relay: { register: async () => {}, unregister: async () => {} },
    tokens: { platform: 'fcm', get: async () => null, onRefresh: () => () => {} },
    store: { read: async () => null, write: async () => {} },
  });
  const seen: Array<string | null> = [];
  reg.onStatus((status) => seen.push(status));
  await reg.enable();
  assert.deepEqual(seen, ['waiting']);
  await reg.disable();
});

test('a disable that lands while the OS is still handing out the token registers nothing and reports no status', async () => {
  const hold = defer();
  const calls: string[] = [];
  const reg = createPushRegistration({
    relay: { register: async () => void calls.push('register'), unregister: async () => void calls.push('unregister') },
    tokens: {
      platform: 'apns',
      get: async () => {
        await hold.promise;
        return 'late-token';
      },
      onRefresh: () => () => {},
    },
    store: { read: async () => null, write: async () => {} },
  });
  const seen: Array<string | null> = [];
  reg.onStatus((status) => seen.push(status));
  const enabling = reg.enable();
  await tick();
  const disabling = reg.disable();
  hold.resolve();
  await Promise.all([enabling, disabling]);
  assert.deepEqual(calls, [], 'no token reached the relay');
  assert.deepEqual(seen, [], 'and no status was announced');
});

test('a disable that lands while the relay is taking the token leaves no "registered" behind', async () => {
  const hold = defer();
  const calls: string[] = [];
  const reg = createPushRegistration({
    relay: {
      register: async () => {
        calls.push('register');
        await hold.promise;
      },
      unregister: async () => void calls.push('unregister'),
    },
    tokens: { platform: 'apns', get: async () => 'tok', onRefresh: () => () => {} },
    store: { read: async () => null, write: async () => {} },
  });
  const seen: Array<string | null> = [];
  reg.onStatus((status) => seen.push(status));
  const enabling = reg.enable();
  await tick();
  const disabling = reg.disable();
  hold.resolve();
  await Promise.all([enabling, disabling]);
  assert.deepEqual(calls, ['register', 'unregister'], 'the token that got in is taken out again');
  assert.deepEqual(seen, [], 'and nothing says registered while notifications are off');
});

test('a relay that refuses the first registration leaves "waiting", not a missing status, and the next sync can retry', async () => {
  let fail = true;
  const reg = createPushRegistration({
    relay: {
      register: async () => {
        if (fail) throw new Error('relay down');
      },
      unregister: async () => {},
    },
    tokens: { platform: 'apns', get: async () => 'tok', onRefresh: () => () => {} },
    store: { read: async () => null, write: async () => {} },
  });
  const seen: Array<string | null> = [];
  reg.onStatus((status) => seen.push(status));
  await assert.rejects(reg.enable(), /relay down/);
  assert.deepEqual(seen, ['waiting']);
  fail = false;
  await reg.sync();
  assert.deepEqual(seen, ['waiting', 'registered']);
  // a failure after a registration keeps what is true: the token the relay has
  fail = true;
  const again = createPushRegistration({
    relay: {
      register: async () => {
        if (fail) throw new Error('relay down');
      },
      unregister: async () => {},
    },
    tokens: { platform: 'apns', get: async () => (fail ? 'tok-2' : 'tok-1'), onRefresh: () => () => {} },
    store: { read: async () => 'tok-0', write: async () => {} },
  });
  const seen2: Array<string | null> = [];
  again.onStatus((status) => seen2.push(status));
  fail = false;
  await again.enable();
  fail = true;
  await assert.rejects(again.sync(), /relay down/);
  assert.deepEqual(seen2, ['registered'], 'a later refusal does not take back the registered status');
});

test('a Not now that could not be saved is still not asked again in this run, but a fresh run asks', async () => {
  let saved: number | null = null;
  let failWrite = true;
  const make = () =>
    createPermissionFlow({
      port: { status: async () => 'undetermined', request: async () => 'denied' },
      store: {
        read: async () => saved,
        write: async (v) => {
          if (failWrite) throw new Error('keychain locked');
          saved = v;
        },
      },
      now: () => 1_000,
    });
  const run = make();
  await assert.rejects(run.dismiss(), /keychain locked/);
  assert.equal(await run.step(), 'later', 'the refusal to save does not bring the card back');
  assert.equal(await make().step(), 'explain', 'nothing was saved, so a new run asks');
  failWrite = false;
  assert.equal(await run.accept(), 'denied');
  assert.equal(await run.step(), 'explain', 'accepting forgets the Not now');
});
