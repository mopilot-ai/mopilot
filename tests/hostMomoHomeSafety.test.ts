// The Host's half of "at most one live home" (host/src/momoHomeSafety.mjs, host/src/methods/momo.mjs): what a Host says it holds with no grant at all, a new home starting above the epoch floor a client names, and an older home told to stand down being retired for good.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createMomoHome } from '../host/src/momoHome.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
// @ts-ignore
import methods from '../host/src/methods/momo.mjs';
// @ts-ignore
import { mayWipe } from '../shared/host/momoHomeSafety.mjs';
// @ts-ignore
import { createMomoMove } from '../host/src/momoMove.mjs';

const MOMO = ['momo'];
function world(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-safety-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { at: 1_700_000_000_000, now: () => clock.at };
  const home = createMomoHome({
    hostId: 'home-aaaa-1111',
    dataDir: path.join(dir, 'data'),
    safeStorage: createFileSafeStorage(path.join(dir, 'config')),
    clock,
    report: () => undefined,
    isMomoChat: () => false,
  });
  return { dir, clock, home };
}

test('a Host with no grant says it holds none and leaves no trace; with a home it says so, and a lapsed grant is no veil', async (t) => {
  const { home, clock, dir } = world(t);
  assert.deepEqual(home.look(), { version: 1, holds: 'none', leaseEpoch: 0, grantLive: false });
  assert.equal(fs.existsSync(path.join(dir, 'data', 'momo')), false, 'asking made nothing on the disk');
  await home.grant({ account: 'a1', features: MOMO });
  await home.start({ name: 'Studio' });
  assert.deepEqual(home.look(), {
    version: 1,
    holds: 'home',
    homeId: 'home-aaaa-1111',
    leaseEpoch: 1,
    name: 'Studio',
    state: 'running',
    grantLive: true,
  });
  clock.at += 8 * 86_400_000;
  const lapsed: any = home.look();
  assert.equal(lapsed.holds, 'home');
  assert.equal(lapsed.grantLive, false);
});

test('a new home starts above this Host’s own epoch, above the newest stamp it saw and above the floor a client names; the same home asking again with a floor takes a new lease', async (t) => {
  const { home } = world(t);
  await home.grant({ account: 'a1', features: MOMO });
  await home.receiveStamp({ homeId: 'elsewhere', leaseEpoch: 9 });
  const started: any = await home.start({ name: 'Studio', floor: 6 });
  assert.equal(started.home.leaseEpoch, 10, 'above the newest stamp (9) and the floor (6)');
  assert.equal(
    ((await home.start({ name: 'Studio' })) as any).home.leaseEpoch,
    10,
    'the same home asking again with none is answered as it is',
  );
  assert.equal(((await home.start({ name: 'Studio', floor: 3 })) as any).home.leaseEpoch, 10, 'a floor below its lease changes nothing');
  assert.equal(
    ((await home.start({ name: 'Studio', floor: 10 })) as any).home.leaseEpoch,
    11,
    'a floor at its lease takes a new one above it',
  );
});

test('a Host that is no home adopts a move only above the newest stamp it has seen, not only above its own record', async (t) => {
  const { home } = world(t);
  await home.receiveStamp({ homeId: 'elsewhere', leaseEpoch: 9 });
  assert.throws(() => home.canAdopt(5), /not newer/);
  assert.throws(() => home.canAdopt(9), /not newer/);
  assert.doesNotThrow(() => home.canAdopt(10));
});

test('a floor that is far above anything this Host knows is refused with a typed answer, never clamped', async (t) => {
  const { home } = world(t);
  await home.grant({ account: 'a1', features: MOMO });
  for (const floor of [65, Number.MAX_SAFE_INTEGER, 1_000_000_000])
    await assert.rejects(home.start({ name: 'Studio', floor }), (e: any) => e.code === 'floor_too_high', String(floor));
  assert.equal(home.look().holds, 'none', 'nothing started');
  assert.equal(((await home.start({ name: 'Studio', floor: 64 })) as any).home.leaseEpoch, 65);
});

test('a home below the lease of a newer one stands down for good: the winner’s lease is kept, its fields are cleared, and the same epoch is decided by the greater id', async (t) => {
  const { home } = world(t);
  assert.deepEqual(await home.standDown({ homeId: 'other', leaseEpoch: 9 }), { stoodDown: false, leaseEpoch: 0 });
  await home.grant({ account: 'a1', features: MOMO });
  await home.start({ name: 'Studio' });
  assert.deepEqual(
    await home.standDown({ homeId: 'a-other', leaseEpoch: 1 }),
    { stoodDown: false, leaseEpoch: 1 },
    'the same epoch and a smaller id: this one wins',
  );
  assert.deepEqual(await home.standDown({ homeId: 'home-aaaa-1111', leaseEpoch: 5 }), { stoodDown: false, leaseEpoch: 1 }, 'the same home');
  assert.equal(home.stamp()?.leaseEpoch, 1);
  assert.deepEqual(
    await home.standDown({ homeId: 'zzzz-other', leaseEpoch: 1, name: 'Mini' }),
    { stoodDown: true, leaseEpoch: 1 },
    'the same epoch and a greater id: this one stands down',
  );
  assert.equal(home.stamp(), null, 'no longer running');
  const rec: any = home.record();
  assert.deepEqual([rec.homeId, rec.name, rec.account, rec.state], [null, '', null, 'none']);
  assert.ok(rec.retired, 'retired, not moved: its data is kept');
  await assert.rejects(home.start({ name: 'Studio' }), /MoMo moved to Mini/);
  // after a Reset clears the tombstone this machine never starts below the winner's lease
  const w2 = world(t);
  await w2.home.grant({ account: 'a1', features: MOMO });
  await w2.home.start({ name: 'Studio' });
  assert.deepEqual(await w2.home.standDown({ homeId: 'other', leaseEpoch: 6, name: 'Mini' }), { stoodDown: true, leaseEpoch: 6 });
  const look: any = w2.home.look();
  assert.deepEqual([look.holds, look.leaseEpoch, look.movedTo.name], ['retired', 6, 'Mini']);
  await w2.home.reset();
  assert.equal(((await w2.home.start({ name: 'Studio' })) as any).home.leaseEpoch, 7, 'above the lease it was retired by');
});

test('a retired home keeps its data and the owner can take it back: it starts again above the home that replaced it, with what it held', async (t) => {
  const { home, dir } = world(t);
  await home.grant({ account: 'a1', features: MOMO });
  await home.start({ name: 'Studio' });
  await home.stores()!.memory.save({ text: 'Lives in Berlin', source: 'user' });
  await home.standDown({ homeId: 'zzzz-other', leaseEpoch: 6, name: 'Mini' });
  assert.ok(fs.existsSync(path.join(dir, 'data', 'momo')), 'its folder is kept');
  await assert.rejects(home.start({ name: 'Studio', floor: 6 }), (e: any) => e.code === 'home_moved', 'a plain start is refused');
  const back: any = await home.start({ name: 'Studio', floor: 6, revive: true });
  assert.equal(back.home.leaseEpoch, 7, 'above the home that replaced it');
  assert.equal(back.home.homeId, 'home-aaaa-1111');
  assert.equal(home.look().holds, 'home');
  assert.match(JSON.stringify(home.stores()!.memory.summary({})), /Berlin/, 'what it held is there');
  const rec: any = home.record();
  assert.equal(rec.retired, null);
  assert.equal(rec.movedTo, null);
});

test('only an explicit Reset deletes a retired home’s data, and a move’s finish never does', async (t) => {
  const { home, dir } = world(t);
  await home.grant({ account: 'a1', features: MOMO });
  await home.start({ name: 'Studio' });
  await home.stores()!.memory.save({ text: 'Lives in Berlin', source: 'user' });
  await home.standDown({ homeId: 'zzzz-other', leaseEpoch: 6, name: 'Mini' });
  const files = () => fs.readdirSync(path.join(dir, 'data', 'momo')).sort();
  const before = files();
  assert.ok(before.length > 0);
  // a move's finish that arrives at a retired home (the old move this home had begun, say) answers as it is and wipes nothing
  const move = createMomoMove({ home });
  const answer: any = await move.finish({ moveId: 'm1', leaseEpoch: 3, name: 'Mini', homeId: 'zzzz-other', receipt: 'x' });
  assert.equal(answer.home.state, 'none');
  assert.deepEqual(files(), before);
  await home.reset();
  assert.equal(home.look().holds, 'none', 'Reset clears the retirement; a fresh start is possible again');
});

test('a stand-down for an epoch this Host has no reason to believe is refused, so a wrong memory cannot retire the legitimate home', async (t) => {
  const { home } = world(t);
  await home.grant({ account: 'a1', features: MOMO });
  await home.start({ name: 'Studio' });
  for (const leaseEpoch of [66, Number.MAX_SAFE_INTEGER])
    await assert.rejects(home.standDown({ homeId: 'other', leaseEpoch }), (e: any) => e.code === 'epoch_unproven', String(leaseEpoch));
  assert.ok(home.stamp(), 'still running');
  await home.receiveStamp({ homeId: 'other', leaseEpoch: 40 });
  assert.deepEqual(
    await home.standDown({ homeId: 'other', leaseEpoch: 70 }),
    { stoodDown: true, leaseEpoch: 70 },
    'a stamp it saw makes 70 believable',
  );
});

test('a stand-down writes the record first: when a lease landed meanwhile it refuses and the services were never paused', async (t) => {
  const { home } = world(t);
  await home.grant({ account: 'a1', features: MOMO });
  await home.start({ name: 'Studio' });
  const calls: string[] = [];
  const lifecycle = home.lifecycle;
  (home as any).lifecycle = async (op: string) => (calls.push(op), lifecycle.call(home, op));
  const swap = home.swap;
  (home as any).swap = async (expected: number, change: (r: any) => unknown) =>
    swap.call(home, expected, (r: any) => {
      r.leaseEpoch = 9; // a newer lease landed
      return change(r);
    });
  await assert.rejects(home.standDown({ homeId: 'zzzz', leaseEpoch: 5 }), /moved on/);
  assert.deepEqual(calls, [], 'no pause before the record changed');
});

test('a stand-down that goes through pauses the services after the record changed, and lets the stores go', async (t) => {
  const { home } = world(t);
  await home.grant({ account: 'a1', features: MOMO });
  await home.start({ name: 'Studio' });
  const order: string[] = [];
  const { lifecycle, swap, close } = home;
  (home as any).lifecycle = async (op: string) => (order.push(`lifecycle:${op}`), lifecycle.call(home, op));
  (home as any).swap = async (...a: any[]) => (order.push('swap'), swap.apply(home, a as any));
  (home as any).close = async () => (order.push('close'), close.call(home));
  await home.standDown({ homeId: 'zzzz', leaseEpoch: 4 });
  assert.deepEqual(order, ['swap', 'lifecycle:pause', 'close']);
});

test('a missing record cannot be stood down', async (t) => {
  const { home } = world(t);
  (home as any).record = () => null;
  await assert.rejects(home.standDown({ homeId: 'other', leaseEpoch: 5 }), /cannot be read/);
});

test('the methods: look and stand-down are the owner’s devices only, with no grant needed, and the schema reads the floor', async (t) => {
  const { home } = world(t);
  const file: any = methods({ momo: home });
  for (const m of ['host.momoHomeLook', 'host.momoStandDown']) {
    assert.equal(file.veils[m]({ kind: 'desktop', fingerprint: 'x', name: 'x' }), true, m);
    assert.equal(file.veils[m]({ kind: 'cli', fingerprint: 'x', name: 'x' }), false, m);
    assert.equal(file.veils[m](null), false, m);
  }
  assert.equal(file.handlers['host.momoHomeLook']().holds, 'none');
  await home.grant({ account: 'a1', features: MOMO });
  assert.deepEqual(await file.handlers['host.momoStandDown']({ homeId: 'o', leaseEpoch: 2 }), { stoodDown: false, leaseEpoch: 0 });
  assert.ok(
    file.features.momoLook({ kind: 'desktop', fingerprint: 'x', name: 'x' }),
    'advertised to the owner’s devices whatever the grant',
  );
  assert.equal(file.features.momoLook({ kind: 'cli', fingerprint: 'x', name: 'x' }), false);
  assert.equal(file.features.momoLook(null), false);
  const { default: schema } = await import('../shared/host/methods/momo.mjs');
  const bad = (m: string) => new Error(m);
  const def: any = schema({
    bad,
    matchOf: (v: any, re: RegExp, m: string) =>
      typeof v === 'string' && re.test(v)
        ? v
        : (() => {
            throw bad(m);
          })(),
  });
  assert.deepEqual(def.methods['host.momoHomeStart'].parse({ name: 'S', floor: 4 }), { name: 'S', floor: 4 });
  assert.deepEqual(def.methods['host.momoHomeStart'].parse({ name: 'S' }), { name: 'S' });
  assert.throws(() => def.methods['host.momoHomeStart'].parse({ name: 'S', floor: -1 }), /epoch/);
  assert.deepEqual(def.methods['host.momoStandDown'].parse({ homeId: 'h1', leaseEpoch: 3, name: 'M' }), {
    homeId: 'h1',
    leaseEpoch: 3,
    name: 'M',
  });
  assert.throws(() => def.methods['host.momoStandDown'].parse({ homeId: 'h1', leaseEpoch: 0 }), /epoch/);
  assert.throws(() => def.methods['host.momoStandDown'].parse({ homeId: 'a b', leaseEpoch: 1 }), /home id/);
  assert.deepEqual(def.methods['host.momoHomeLook'].parse({}), {});
});

test('a machine that keeps a retired copy takes no move: the offer and the adopt are refused, and nothing wipes the copy', async (t) => {
  const { home, dir } = world(t);
  await home.grant({ account: 'a1', features: MOMO });
  await home.start({ name: 'Studio' });
  await home.stores()!.memory.save({ text: 'Lives in Berlin', source: 'user' });
  await home.standDown({ homeId: 'zzzz-other', leaseEpoch: 6, name: 'Mini' });
  const before = fs.readdirSync(path.join(dir, 'data', 'momo')).sort();
  const move = createMomoMove({ home });
  await assert.rejects(move.offer({ moveId: 'm9' }), (e: any) => e.code === 'retired_copy_here' && /older MoMo/.test(e.message));
  assert.throws(
    () => home.canAdopt(99),
    (e: any) => e.code === 'retired_copy_here',
  );
  assert.deepEqual(fs.readdirSync(path.join(dir, 'data', 'momo')).sort(), before, 'the copy is as it was');
});

test('"Delete the old MoMo" is refused unless the copy is still retired at the epoch the owner saw; a plain Reset is the owner’s own', async (t) => {
  const { home } = world(t);
  await home.grant({ account: 'a1', features: MOMO });
  await home.start({ name: 'Studio' });
  await assert.rejects(home.reset({ ifRetired: true }), (e: any) => e.code === 'retired_changed', 'a running home is never deleted by it');
  await home.standDown({ homeId: 'zzzz-other', leaseEpoch: 6, name: 'Mini' });
  await assert.rejects(
    home.reset({ ifRetired: true, expectEpoch: 5 }),
    (e: any) => e.code === 'retired_changed',
    'retired at another lease',
  );
  await home.start({ name: 'Studio', floor: 6, revive: true });
  await home.stores()!.memory.save({ text: 'Lives in Berlin', source: 'user' });
  await assert.rejects(home.reset({ ifRetired: true, expectEpoch: 6 }), (e: any) => e.code === 'retired_changed', 'taken back meanwhile');
  assert.match(JSON.stringify(home.stores()!.memory.summary({})), /Berlin/, 'nothing was wiped');
  await home.standDown({ homeId: 'zzzz-other', leaseEpoch: 9, name: 'Mini' });
  const gone: any = await home.reset({ ifRetired: true, expectEpoch: 9 });
  assert.equal(gone.home, null, 'the retired copy was deleted and the retirement cleared');
});

test('a retired home takes the winner’s real lease in further stand-downs, each within the bound; a stand-down from a stranger lease is refused', async (t) => {
  const { home } = world(t);
  await home.grant({ account: 'a1', features: MOMO });
  await home.start({ name: 'Studio' });
  await home.standDown({ homeId: 'zzzz-other', leaseEpoch: 60, name: 'Mini' });
  assert.deepEqual(await home.standDown({ homeId: 'zzzz-other', leaseEpoch: 120 }), { stoodDown: true, leaseEpoch: 120 });
  assert.equal((home.look() as any).leaseEpoch, 120);
  await assert.rejects(home.standDown({ homeId: 'zzzz-other', leaseEpoch: 400 }), (e: any) => e.code === 'epoch_unproven');
  assert.deepEqual(
    await home.standDown({ homeId: 'zzzz-other', leaseEpoch: 100 }),
    { stoodDown: false, leaseEpoch: 120 },
    'lower: nothing to raise',
  );
  assert.deepEqual(
    await home.standDown({ homeId: 'someone-else', leaseEpoch: 130 }),
    { stoodDown: false, leaseEpoch: 120 },
    'another winner is not this retirement',
  );
});

test('a lease bump or an answer as it is touches only the record: services are not restarted, only a home that is taken starts them', async (t) => {
  const { home } = world(t);
  await home.grant({ account: 'a1', features: MOMO });
  const ops: string[] = [];
  const lifecycle = home.lifecycle;
  (home as any).lifecycle = async (op: string) => (ops.push(op), lifecycle.call(home, op));
  await home.start({ name: 'Studio' });
  assert.deepEqual(ops, ['start']);
  await home.start({ name: 'Studio' });
  await home.start({ name: 'Studio', floor: 1 });
  await home.start({ name: 'Studio', floor: 5 });
  assert.equal((home.look() as any).leaseEpoch, 6, 'the lease rose');
  assert.deepEqual(ops, ['start'], 'and nothing restarted');
});

test('a retired record written without a "last active" time reads with the time it was retired, and a stand-down raise that loses a race to a lease refuses', async (t) => {
  const { home } = world(t);
  await home.grant({ account: 'a1', features: MOMO });
  await home.start({ name: 'Studio' });
  await home.standDown({ homeId: 'zzzz-other', leaseEpoch: 60, name: 'Mini' });
  // an older file: a retirement with no `lastActive`
  await home.swap((home.record() as any).leaseEpoch, (r: any) => {
    r.retired = { at: 1234 };
    return false;
  });
  assert.equal((home.look() as any).lastActive, 1234);
  // the raise rule runs again inside the write: a lease that landed meanwhile refuses it
  const swap = home.swap;
  (home as any).swap = async (expected: number, change: (r: any) => unknown) =>
    swap.call(home, expected, (r: any) => {
      r.movedTo = { ...r.movedTo, homeId: 'someone-else' };
      return change(r);
    });
  await assert.rejects(home.standDown({ homeId: 'zzzz-other', leaseEpoch: 100 }), /moved on/);
});

test('a move may wipe only a record it could read that is not a retired copy', () => {
  const rec = { homeId: null, leaseEpoch: 1, state: 'none', name: '', movedTo: null, retired: null } as any;
  assert.equal(mayWipe(rec), true);
  assert.equal(mayWipe({ ...rec, retired: { at: 1, lastActive: 1 } }), false);
  assert.equal(mayWipe(null), false);
});

test('the wire parameters of reset, start and stand-down: each optional field is read only when it is well formed', async () => {
  const { default: schema } = await import('../shared/host/methods/momo.mjs');
  const bad = (m: string) => new Error(m);
  const def: any = schema({
    bad,
    matchOf: (v: any, re: RegExp, m: string) =>
      typeof v === 'string' && re.test(v)
        ? v
        : (() => {
            throw bad(m);
          })(),
  });
  const reset = def.methods['host.momoReset'].parse;
  assert.deepEqual(reset({}), {});
  assert.deepEqual(reset({ ifRetired: true, expectEpoch: 3 }), { ifRetired: true, expectEpoch: 3 });
  assert.deepEqual(reset({ ifRetired: 'yes', expectEpoch: -1 }), {}, 'neither a non-true flag nor a negative epoch is read');
  assert.deepEqual(reset({ expectEpoch: 'x' }), {});
  const start = def.methods['host.momoHomeStart'].parse;
  assert.deepEqual(start({ name: 'S', revive: true }), { name: 'S', revive: true });
  assert.deepEqual(start({ name: 'S', revive: 'yes' }), { name: 'S' });
  const stand = def.methods['host.momoStandDown'].parse;
  assert.deepEqual(stand({ homeId: 'h1', leaseEpoch: 3 }), { homeId: 'h1', leaseEpoch: 3 });
});
