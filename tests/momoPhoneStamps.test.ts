// The phone refuses what an old home says: a view, an event, an answer or a push whose lease stamp is older than the newest seen is dropped; the newest is kept sealed per account, so a restart does not forget it; and the owner can take the home back when a move could not finish.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createFixtureTransport, createMomoStore, fixtureView, find, mount, tap, type Any } from './support/phone/momo-screens';

const cachePath = '../mobile/src/momoPhone/homeCache';
const stampsPath = '../mobile/src/momoPhone/stamps';
const pushPath = '../mobile/src/momoPhone/pushStamps';
const payloadPath = '../mobile/src/push/payload';
const dataPath = '../mobile/src/push/dataMessage';
const { createHomeCache, guardHomeCache } = await import(cachePath);
const sinkPath = '../shared/momoStamp.mjs';
const { createStampSink } = await import(sinkPath);
const { openStamps, stampOf } = await import(stampsPath);
const { createPushAdmit, guardTaps } = await import(pushPath);
const { parsePushPayload } = await import(payloadPath);
const { buildNotification } = await import(dataPath);
const prefsPath = '../mobile/src/push/prefs';
const { DEFAULT_PREFS } = await import(prefsPath);

function memory() {
  let raw: string | null = null;
  const xor = (bytes: Uint8Array) => bytes.map((b) => b ^ 0x5a);
  const cache = createHomeCache({
    store: { read: async () => raw, write: async (v: string) => void (raw = v), clear: async () => void (raw = null) },
    crypto: {
      key: async () => new Uint8Array(32),
      randomBytes: (n: number) => new Uint8Array(n).fill(7),
      seal: (_k: Uint8Array, _n: Uint8Array, plain: Uint8Array, aad: string) =>
        xor(new Uint8Array([...new TextEncoder().encode(`${aad}|`), ...plain])),
      open: (_k: Uint8Array, _n: Uint8Array, box: Uint8Array, aad: string) => {
        const text = new TextDecoder().decode(xor(box));
        return text.startsWith(`${aad}|`) ? new TextEncoder().encode(text.slice(aad.length + 1)) : null;
      },
    },
  });
  return { cache, raw: () => raw, set: (v: string | null) => void (raw = v) };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const viewAt = (homeMachineId: string | null, leaseEpoch: number | null) => {
  const v = fixtureView();
  Object.assign(v.view.home, { homeMachineId, leaseEpoch });
  return v;
};

test('a view says which lease it is from; one with none yet is read as none', () => {
  assert.deepEqual(stampOf(viewAt('studio', 4)), { homeId: 'studio', leaseEpoch: 4 });
  assert.equal(stampOf(viewAt(null, null)), null);
  assert.equal(stampOf(viewAt('studio', null)), null);
});

test('the newest lease wins: an older view, and a second machine at the same lease, are refused; a newer one replaces', async () => {
  const m = memory();
  const admit = await openStamps(m.cache, 'u1');
  assert.equal(admit.view(viewAt(null, null)), true, 'nothing seen yet: a home with no lease yet is taken');
  assert.equal(admit.view(viewAt('studio', 2)), true);
  assert.equal(admit.view(viewAt('studio', 2)), true, 'the same lease again');
  assert.equal(admit.view(viewAt('studio', 1)), false, 'an old home after a reclaim');
  assert.equal(admit.view(viewAt('mini', 2)), false, 'two machines at one lease: neither is trusted');
  assert.equal(admit.view(viewAt(null, null)), false, 'a view with no lease is not the home once a lease was seen');
  assert.equal(admit.view(viewAt('mini', 3)), true, 'a newer lease replaces');
  await settle();
  assert.equal(admit.view(viewAt('studio', 2)), false);
});

test('the newest lease survives a restart, per account, sealed on the phone', async () => {
  const m = memory();
  const first = await openStamps(m.cache, 'u1', async () => undefined);
  assert.equal(first.view(viewAt('mini', 5)), true);
  await settle();
  assert.equal(JSON.stringify(m.raw()).includes('mini'), false, 'what is kept is sealed');
  const again = await openStamps(m.cache, 'u1');
  assert.equal(again.view(viewAt('studio', 4)), false, 'the restarted phone still refuses the old home');
  assert.equal(again.view(viewAt('mini', 5)), true);
  const other = await openStamps(m.cache, 'u2');
  assert.equal(other.view(viewAt('studio', 4)), true, 'another account has its own');
});

test('a lease that cannot be read, or kept, or a phone with no copy, does not keep the person out', async () => {
  const m = memory();
  m.set('not json');
  const broken = await openStamps(m.cache, 'u1');
  assert.equal(broken.view(viewAt('studio', 1)), true, 'starts from none');
  const none = await openStamps(null, 'u1');
  assert.equal(none.view(viewAt('studio', 2)), true);
  assert.equal(none.view(viewAt('studio', 1)), false, 'within this run it still refuses the old home');
  const throwing = await openStamps(
    { newest: async () => Promise.reject(new Error('disk')), keepStamp: async () => Promise.reject(new Error('disk')) } as Any,
    'u1',
  );
  assert.equal(throwing.view(viewAt('studio', 1)), true);
  await settle();
});

test('the sealed stamps: none, ok, unreadable; kept beside the rows and dropped with sign-out, an account’s push row with it', async () => {
  const m = memory();
  assert.deepEqual(await m.cache.newest('u1'), { status: 'none' });
  await m.cache.keepStamp('u1', { homeId: 'a', leaseEpoch: 2 });
  await m.cache.keepStamp('u2', { homeId: 'b', leaseEpoch: 3 });
  await m.cache.keepStamp('u1', { homeId: 'a', leaseEpoch: 4 });
  await m.cache.save({ user: 'u1', pair: 'p1' }, { notes: [], turns: [] });
  assert.deepEqual(await m.cache.newest('u1'), { status: 'ok', stamp: { homeId: 'a', leaseEpoch: 4 } });
  const stampUsers = () =>
    m.raw()
      ? JSON.parse(m.raw()!)
          .stamps.map((r: Any) => r.user)
          .sort()
      : [];
  assert.deepEqual(stampUsers(), ['u1', 'u2']);
  // the rows' own forget leaves the stamps; sign-out takes both
  await m.cache.forget(() => true);
  assert.deepEqual(stampUsers(), ['u1', 'u2']);
  await m.cache.forget(
    () => true,
    (u: string) => u === 'u2',
  );
  assert.deepEqual(stampUsers(), ['u1']);
  await m.cache.forget(
    () => true,
    () => true,
  );
  assert.equal(m.raw(), null);
  // a stamp that is kept and cannot be opened is unreadable, and a damaged container reads none and writes nothing
  await m.cache.keepStamp('u1', { homeId: 'a', leaseEpoch: 1 });
  const row = JSON.parse(m.raw()!);
  row.stamps[0].box = row.stamps[0].box.replace(/^../, 'ff');
  m.set(JSON.stringify(row));
  assert.deepEqual(await m.cache.newest('u1'), { status: 'unreadable' });
  m.set(
    JSON.stringify({ rows: [], stamps: [{ user: 'u1', nonce: '00', box: '00' }, { user: 'u2', nonce: 'zz', box: 'zz' }, { user: 1 }] }),
  );
  assert.deepEqual(await m.cache.newest('u1'), { status: 'unreadable' });
  m.set('not json');
  assert.deepEqual([await m.cache.newest('u1')], [{ status: 'unreadable' }]);
  await assert.rejects(m.cache.keepStamp('u1', { homeId: 'a', leaseEpoch: 1 }));
  // a store that cannot be read
  const gone = createHomeCache({
    store: { read: async () => Promise.reject(new Error('disk')), write: async () => undefined, clear: async () => undefined },
    crypto: {
      key: async () => new Uint8Array(32),
      randomBytes: () => new Uint8Array(24),
      seal: (_k: Uint8Array, _n: Uint8Array, p: Uint8Array) => p,
      open: () => null,
    },
  });
  assert.deepEqual([await gone.newest('u1')], [{ status: 'unreadable' }]);
});

test('the launch guard drops the stamps of an account that is not signed in, and keeps a signed-in account’s', async () => {
  const m = memory();
  await m.cache.keepStamp('u1', { homeId: 'a', leaseEpoch: 2 });
  await m.cache.keepStamp('u2', { homeId: 'b', leaseEpoch: 3 });
  await m.cache.keepStamp('u1|push', { homeId: 'a', leaseEpoch: 2 });
  await m.cache.keepStamp('u2|push', { homeId: 'b', leaseEpoch: 3 });
  const state: Any = { phase: 'online', user: { id: 'u1' }, pairs: [{ pairId: 'p1' }] };
  const listeners = new Set<() => void>();
  const stop = guardHomeCache(
    { snapshot: () => state, subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)) },
    m.cache,
  );
  await settle();
  const stampUsers = () =>
    m.raw()
      ? JSON.parse(m.raw()!)
          .stamps.map((r: Any) => r.user)
          .sort()
      : [];
  assert.deepEqual(stampUsers(), ['u1', 'u1|push'], 'a signed-in account keeps its stamps, its push row too');
  state.user = null;
  for (const l of listeners) l();
  await settle();
  assert.equal(m.raw(), null);
  stop();
});

const withStamps = (admit: Any) => ({ stamps: async () => admit });
const sink = async (newest?: [string, number]) => {
  const m = memory();
  const admit = await openStamps(m.cache, 'u1');
  if (newest) admit.view(viewAt(newest[0], newest[1]));
  return admit;
};

test('the store drops an old home’s view, event and answer, takes a newer one, and says an old home is not the home', async () => {
  const admit = await sink();
  const subs: Any[] = [];
  const answers: Any[] = [];
  const base = viewAt('studio', 2);
  const transport = {
    load: async () => base,
    subscribe: (l: Any) => (subs.push(l), () => undefined),
    send: async () => answers.shift() ?? { ok: true },
  };
  const store = createMomoStore(transport, withStamps(admit));
  await store.load();
  assert.equal(store.get().failure, null);
  const v = (e: [string, number], name: string) => {
    const x = viewAt(e[0], e[1]);
    x.view.home.machineName = name;
    return x.view;
  };
  subs[0]({ view: v(['studio', 1], 'Old home') });
  assert.equal(store.get().view.view.home.machineName, 'Studio', 'an old home’s event is dropped');
  subs[0]({ view: v(['mini', 3], 'Mini') });
  assert.equal(store.get().view.view.home.machineName, 'Mini', 'a newer one replaces');
  answers.push({ ok: true, view: { view: v(['studio', 1], 'Old again') } });
  assert.equal((await store.act({ kind: 'task-check', taskId: 't1' })).ok, true);
  assert.equal(store.get().view.view.home.machineName, 'Mini', 'an old home’s answer is dropped too');
  // the door: a computer that is an old home is told so
  await store.load();
  assert.equal(store.get().view.view.home.machineName, 'Mini', 'a second read asks nothing of the lease again');
  const late = createMomoStore({ ...transport, load: async () => viewAt('studio', 1) }, withStamps(admit));
  await late.load();
  assert.equal(late.get().view, null);
  assert.equal(late.get().failure.cause, "That computer isn't MoMo's home any more.");
});

test('a view that cannot be admitted before the lease is known, and a store with nothing to check, take what the home says', async () => {
  const none = createMomoStore(createFixtureTransport(fixtureView()));
  await none.load();
  assert.ok(none.get().view);
  let release: (a: Any) => void = () => undefined;
  const slow = createMomoStore(createFixtureTransport(fixtureView()), { stamps: () => new Promise((resolve) => (release = resolve)) });
  const loading = slow.load();
  await settle();
  assert.equal(slow.get().view, null, 'nothing is taken before the newest lease has been read');
  release(await sink());
  await loading;
  assert.ok(slow.get().view);
  const gone = createMomoStore(createFixtureTransport(fixtureView()), withStamps(await sink()));
  const pending = gone.load();
  gone.dispose();
  await pending;
  assert.equal(gone.get().view, null);
});

test('a push carries its lease sealed in `ss`; flat fields are not read, and only MoMo’s own pushes carry one', () => {
  const sealed = parsePushPayload({ kind: 'momoNeedsYou', ref: 'r', ss: 'AAAA', homeId: 'studio', leaseEpoch: 9 });
  assert.equal(sealed.sealedStamp, 'AAAA');
  assert.equal('stamp' in sealed, false, 'nothing in plaintext is believed');
  assert.equal(parsePushPayload({ kind: 'momoNeedsYou', ref: 'r', homeId: 'studio', leaseEpoch: 9 }).sealedStamp, undefined);
  assert.equal(parsePushPayload({ kind: 'momoNeedsYou', ref: 'r', ss: 'x'.repeat(257) }).sealedStamp, undefined, 'too long to be one');
  assert.equal(parsePushPayload({ kind: 'needsYou', ref: 'r', ss: 'AAAA' }).sealedStamp, undefined);
});

const sodiumPath = '../electron/platform/sodiumPrimitives.cjs';
const requireCjs = createRequire(import.meta.url);
const prim = requireCjs(sodiumPath).createSodiumPrimitives();
const sealPath = '../shared/remote/stampSeal.mjs';
const { createStampSeal } = await import(sealPath);
const stampSeal = createStampSeal(prim);
const ROOT = new Uint8Array(32).fill(3);
const OTHER = new Uint8Array(32).fill(4);
const sealFor = (root: Uint8Array, ref: string, homeId: string, leaseEpoch: number) =>
  stampSeal.seal({ key: stampSeal.stampKey(root), ref, homeId, leaseEpoch });
const momo = (ref: string, ss?: string): Any => ({ kind: 'momoNeedsYou', ref, count: 1, ...(ss ? { sealedStamp: ss } : {}) });

function pusher(m = memory(), over: Any = {}) {
  const calls = { context: 0, marks: 0 };
  const admit = createPushAdmit({
    context: async () => (
      calls.context++,
      { user: 'u1', open: (sealed: string, ref: string) => stampSeal.open({ sealed, ref, keys: [stampSeal.stampKey(ROOT)] }) }
    ),
    cache: async () => m.cache,
    wasUsed: async () => true,
    mark: async () => void calls.marks++,
    ...over,
  });
  return { admit, m, calls };
}

test('a sealed stamp that opens is believed when it is current and refused when it is old; a newer one replaces', async () => {
  const { admit, calls } = pusher();
  assert.equal(await admit(momo('r1', sealFor(ROOT, 'r1', 'mini', 5))), true);
  assert.ok(calls.marks >= 1, 'the copy is marked as used');
  assert.equal(await admit(momo('r2', sealFor(ROOT, 'r2', 'mini', 5))), true, 'the same lease again');
  assert.equal(await admit(momo('r3', sealFor(ROOT, 'r3', 'studio', 4))), false, 'an old home after a reclaim');
  assert.equal(await admit(momo('r4', sealFor(ROOT, 'r4', 'studio', 5))), false, 'two machines at one lease');
  assert.equal(await admit(momo('r5', sealFor(ROOT, 'r5', 'cloud', 6))), true, 'a newer lease replaces');
  assert.equal(await admit(momo('r6', sealFor(ROOT, 'r6', 'mini', 5))), false);
});

test('once a stamped push was seen, one that is missing its stamp, sealed for another pair or another ref, or garbage draws nothing', async () => {
  const { admit } = pusher();
  assert.equal(await admit(momo('r0')), true, 'before any stamped push an unstamped one is believed');
  assert.equal(await admit(momo('r1', sealFor(ROOT, 'r1', 'mini', 5))), true);
  assert.equal(await admit(momo('r2')), false, 'no stamp');
  assert.equal(await admit(momo('r3', sealFor(OTHER, 'r3', 'mini', 9))), false, 'sealed for another pair');
  assert.equal(await admit(momo('r4', sealFor(ROOT, 'other-ref', 'mini', 9))), false, 'sealed for another ref');
  assert.equal(await admit(momo('r5', 'not-a-sealed-stamp')), false, 'garbage');
  assert.equal(await admit(momo('r6', 'x'.repeat(300))), false, 'too long');
});

test('what was seen survives a restart: a fresh phone over the same copy still refuses an old home and an unstamped push', async () => {
  const m = memory();
  await pusher(m).admit(momo('r1', sealFor(ROOT, 'r1', 'mini', 5)));
  await settle();
  const restarted = pusher(m).admit;
  assert.equal(await restarted(momo('r2', sealFor(ROOT, 'r2', 'studio', 4))), false);
  assert.equal(await restarted(momo('r3')), false);
  assert.equal(await restarted(momo('r4', sealFor(ROOT, 'r4', 'mini', 5))), true);
});

test('other kinds of push are never touched, and a phone with nothing to check with, or no copy, refuses nothing', async () => {
  const seen = pusher();
  await seen.admit(momo('r1', sealFor(ROOT, 'r1', 'mini', 5)));
  const calls = seen.calls.context;
  for (const kind of ['needsYou', 'done', 'machineOffline', 'cleared'])
    assert.equal(await seen.admit({ kind, ref: 'r', count: 1, sealedStamp: 'garbage' }), true);
  assert.equal(seen.calls.context, calls, 'a legacy push does not even look');
  const unused = pusher(seen.m, { wasUsed: async () => false });
  assert.equal(await unused.admit(momo('r2')), true, 'MoMo’s home was never used on this phone');
  const nobody = pusher(seen.m, { context: async () => null });
  assert.equal(await nobody.admit(momo('r3')), true, 'nobody signed in, or no Host enrolled');
  const broken = pusher(seen.m, { cache: async () => Promise.reject(new Error('disk')) });
  assert.equal(await broken.admit(momo('r4', sealFor(ROOT, 'r4', 'studio', 1))), true, 'a copy that cannot be opened refuses nothing');
  const unmarked = pusher(memory(), { mark: undefined });
  assert.equal(await unmarked.admit(momo('r5', sealFor(ROOT, 'r5', 'mini', 1))), true);
});

test('a data message of an old home draws nothing', async () => {
  const prefs = async () => ({ ...DEFAULT_PREFS, titles: false });
  const o = { keys: async () => [], open: () => null, prefs };
  const data = { kind: 'momoNeedsYou', ref: 'r', homeId: 'studio', leaseEpoch: 1 };
  assert.equal(await buildNotification(data, { ...o, admit: async () => false }), null);
  assert.ok(await buildNotification(data, { ...o, admit: async () => true }));
  assert.ok(await buildNotification(data, o));
});

test('a move that could not finish offers Run MoMo here again only when the home offers it; its words come first and only its button sends the reclaim', async () => {
  const failed = (reclaim: unknown) => (v: Any) =>
    (v.home.move = {
      moveId: 'm1',
      from: { machineId: 'studio', name: 'Studio' },
      to: { machineId: 'mini', name: 'Mac mini' },
      step: 'copied',
      outcome: 'failed',
      failure: { cause: 'Mac mini went offline.', failedAt: 'copied' },
      oldMachineOffline: false,
      reclaim,
    });
  const none = await mount(failed(undefined));
  await tap('MoMo · Studio');
  assert.equal(find('Run MoMo here again'), undefined, 'not offered unless the home offers it');
  const words = { title: 'Run MoMo on Studio again?', body: 'Mac mini is asked first.', confirm: 'Run it here' };
  const m = await mount(failed(words));
  await tap('MoMo · Studio');
  assert.deepEqual(m.sent, []);
  await tap('Run MoMo here again');
  assert.match(m.text(), /Run MoMo on Studio again\?/);
  assert.match(m.text(), /Mac mini is asked first\./);
  assert.deepEqual(m.sent, [], 'nothing is sent before the confirmation');
  await tap('Cancel');
  assert.ok(find('Run MoMo here again'));
  await tap('Run MoMo here again');
  await tap('Run it here');
  assert.deepEqual(m.sent, [{ kind: 'reclaim', moveId: 'm1', toId: 'mini' }]);
  assert.doesNotMatch(m.text(), /Run it here/, 'the move is over');
  void none;
});

test('a tap on an old home’s push opens no card; a tap on a current one does', async () => {
  let deliver: (p: Any, reply?: string) => void = () => undefined;
  const got: Any[] = [];
  const tapped = guardTaps(
    async (p: Any) => p.ref !== 'old',
    (l: Any) => ((deliver = l), () => undefined),
  )((p: Any, reply?: string) => got.push([p.ref, reply]));
  assert.equal(typeof tapped, 'function');
  deliver({ ref: 'old' }, 'x');
  deliver({ ref: 'new' }, 'y');
  await settle();
  assert.deepEqual(got, [['new', 'y']]);
});

test('a read that comes back after the screen went changes nothing', async () => {
  let arrive: (v: Any) => void = () => undefined;
  const store = createMomoStore(
    { load: () => new Promise((resolve) => (arrive = resolve)), subscribe: () => () => undefined, send: async () => ({ ok: true }) },
    withStamps(await sink()),
  );
  const loading = store.load();
  await settle();
  store.dispose();
  arrive(viewAt('studio', 1));
  await loading;
  assert.equal(store.get().view, null);
});

test('the shared sink refuses what is not a stamp, a stale lease and two machines at one lease, and says why', () => {
  let newest: Any = null;
  const sink = createStampSink({ read: () => newest, write: (n: Any) => void (newest = n) });
  for (const junk of [null, 'x', {}, { homeId: '', leaseEpoch: 1 }, { homeId: 'a', leaseEpoch: 0 }, { homeId: 'a', leaseEpoch: 1.5 }])
    assert.deepEqual(sink.accept(junk), { ok: false, reason: 'not-a-stamp', newest: null });
  assert.deepEqual(sink.accept({ homeId: 'a', leaseEpoch: 2 }), { ok: true });
  assert.equal(sink.accept({ homeId: 'a', leaseEpoch: 1 }).reason, 'stale');
  assert.equal(sink.accept({ homeId: 'b', leaseEpoch: 2 }).reason, 'two-homes');
  assert.deepEqual(sink.newest(), { homeId: 'a', leaseEpoch: 2 });
});

test('the sealed stamp refuses what is not one when sealing, and opens only what was sealed for this key and ref', () => {
  const key = stampSeal.stampKey(ROOT);
  for (const bad of [
    { homeId: '', leaseEpoch: 1 },
    { homeId: 'h'.repeat(65), leaseEpoch: 1 },
    { homeId: 'a', leaseEpoch: 0 },
    { homeId: 'a', leaseEpoch: 1.5 },
    { homeId: 3, leaseEpoch: 1 },
  ])
    assert.equal(stampSeal.seal({ key, ref: 'r', ...bad }), null);
  const good = stampSeal.seal({ key, ref: 'r', homeId: 'mini', leaseEpoch: 2 });
  assert.deepEqual(stampSeal.open({ sealed: good, ref: 'r', keys: [new Uint8Array(32), key] }), { homeId: 'mini', leaseEpoch: 2 });
  const open = (sealed: unknown, keys = [key]) => stampSeal.open({ sealed: sealed as string, ref: 'r', keys });
  assert.equal(open(3), null);
  assert.equal(open('x'.repeat(257)), null);
  assert.equal(open('!!!!'), null, 'not base64');
  assert.equal(open('AAAA'), null, 'too short');
  const asBytes = Buffer.from(good.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const withByte = (i: number, v: number) => Buffer.from(Uint8Array.from(asBytes, (b, at) => (at === i ? v : b))).toString('base64url');
  assert.equal(open(withByte(0, 9)), null, 'another version');
  assert.equal(open(withByte(40, asBytes[40] ^ 1)), null, 'a changed byte does not open');
  assert.equal(open(good, [new Uint8Array(5)]), null, 'a key of the wrong length is skipped');
  assert.equal(open(good, [stampSeal.stampKey(OTHER)]), null);
  // sealed correctly but not a stamp inside
  const wrap = (plain: string) => {
    const nonce = new Uint8Array(24).fill(1);
    const box = prim.aeadSeal(key, nonce, new TextEncoder().encode(plain), new TextEncoder().encode('mopilot-push-stamp-v1|r'));
    const out = new Uint8Array(1 + 24 + box.length);
    out[0] = 1;
    out.set(nonce, 1);
    out.set(box, 25);
    return Buffer.from(out).toString('base64url');
  };
  for (const plain of ['not json', '{}', '{"h":"","e":1}', '{"h":"a","e":0}', `{"h":"${'a'.repeat(65)}","e":1}`])
    assert.equal(open(wrap(plain)), null, plain);
  assert.deepEqual(open(wrap('{"h":"a","e":3}')), { homeId: 'a', leaseEpoch: 3 });
});

test('a cipher that throws on one key is skipped, not fatal', () => {
  const key = stampSeal.stampKey(ROOT);
  const good = stampSeal.seal({ key, ref: 'r', homeId: 'mini', leaseEpoch: 2 });
  let first = true;
  const flaky = createStampSeal({
    ...prim,
    aeadOpen: (...a: Any[]) => {
      if (first) {
        first = false;
        throw new Error('bad key');
      }
      return prim.aeadOpen(...a);
    },
  });
  assert.deepEqual(flaky.open({ sealed: good, ref: 'r', keys: [new Uint8Array(32), key] }), { homeId: 'mini', leaseEpoch: 2 });
});
