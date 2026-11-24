// The rules of the home's safety, unit by unit: the epoch a start takes and what it refuses, what a Host says it holds, how a client reads a version and what a machine said (nothing guessed), the climb to a far floor, and a move's target and a retired home's copy. The model that walks them in every order is tests/momoHomeSafetyModel.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { adoptRule, lookOf, resetRule, startEpoch, startRule } from '../shared/host/momoHomeSafety.mjs';
// @ts-ignore
import { oldHome } from '../shared/host/momoMovePhases.mjs';
// @ts-ignore
import { answerOf, createSteps, decide, execute, olderRelease, releaseOf } from '../shared/host/momoHomeClient.mjs';
import { fresh, hostStart, machines, none, running } from './support/momoHomeModel.ts';

test('the move target adopts only above the newest stamp it saw, and a finish at a retired home never deletes its copy', async () => {
  const w = fresh(['a', 'b', 'c']);
  w.hosts[1]!.known = 5;
  assert.ok(adoptRule(w.hosts[1]!.rec as any, 2, w.hosts[1]!.known), 'epoch 2 is not above a stamp at 5');
  assert.equal(adoptRule(w.hosts[1]!.rec as any, 6, 5), null);
  const retired = { ...none(), leaseEpoch: 6, movedTo: { name: 'b', homeId: 'b', at: 0 }, retired: { at: 1, lastActive: 0 } };
  assert.deepEqual(oldHome.finish(retired, { moveId: 'm1', leaseEpoch: 3, receiptOk: true }), { noop: true, keep: true });
});

test('a home that is moving is never re-leased by a start: it is answered as it is, so a move’s lease is not changed under it', () => {
  const moving = { ...running('a', 2), state: 'moving' as const };
  assert.deepEqual(startRule(moving as any, { hostId: 'a', name: 'a', floor: 9, known: 0 }), { asis: true });
  assert.deepEqual(
    startRule(running('a', 2) as any, { hostId: 'a', name: 'a', floor: 1, known: 0 }),
    { asis: true },
    'a floor below its lease changes nothing',
  );
  assert.ok('set' in startRule(running('a', 2) as any, { hostId: 'a', name: 'a', floor: 2, known: 0 }), 'at its lease it takes a new one');
  assert.equal((startRule(running('b', 2) as any, { hostId: 'a', name: 'a', floor: 2, known: 0 }) as any).refuse.code, 'home_exists');
});

test('a climb to a far floor takes repeated starts, a failed start stands nobody down, and a stand-down uses the lease the start really got', async () => {
  // a Host that has never heard of anything near epoch 500: one start takes at most 64 above it, so the client climbs
  const w = fresh(['a', 'b', 'c']);
  w.hosts[0]!.reachable = false;
  w.clients[0] = { seen: 500, chosen: null };
  const d = decide(machines(w), w.clients[0]!);
  assert.equal(d.floor, 500);
  const calls: number[] = [];
  const ran = await execute(createSteps(d, { id: 'b', name: 'b', own: 0 }), async (step: any) => {
    const r = hostStart(w, w.hosts[1]!, step.params);
    calls.push(step.params.floor);
    return r;
  });
  assert.deepEqual(ran, { ok: true, lease: 501 });
  assert.ok(calls.length > 1 && calls.length <= 9, `climbed in ${calls.length} starts`);
  assert.ok(calls.every((f) => f <= 500));
  // a start that fails: nobody is stood down
  const seen: string[] = [];
  const failed = await execute(
    [
      { call: 'host.momoHomeStart', host: 'b', params: { name: 'b', floor: 1, climbTo: 1 } },
      { call: 'host.momoStandDown', host: 'a', params: { homeId: 'b', leaseEpoch: null } },
    ],
    async (step: any) => (seen.push(step.call), { ok: false, code: 'floor_too_high' }),
  );
  assert.deepEqual([failed.ok, seen], [false, ['host.momoHomeStart']]);
  // a climb that never gets above the target stops, with a typed answer
  const stuck = await execute([{ call: 'host.momoHomeStart', host: 'b', params: { name: 'b', floor: 1, climbTo: 9 } }], async () => ({
    ok: true,
    leaseEpoch: 2,
    homeId: 'b',
  }));
  assert.deepEqual([stuck.ok, (stuck as any).code], [false, 'climb_failed']);
  // the stand-down carries the lease the start returned, not a number the client worked out
  const lease: number[] = [];
  await execute(
    [
      { call: 'host.momoHomeStart', host: 'b', params: { name: 'b', floor: 3, climbTo: 3 } },
      { call: 'host.momoStandDown', host: 'a', params: { homeId: 'b', leaseEpoch: null } },
    ],
    async (step: any) =>
      step.call === 'host.momoHomeStart'
        ? { ok: true, leaseEpoch: 7, homeId: 'b' }
        : (lease.push(step.params.leaseEpoch), { ok: true, leaseEpoch: 7 }),
  );
  assert.deepEqual(lease, [7]);
});

test('startEpoch refuses a floor that is not an epoch, one far above this Host, and a start past the limit; never clamps', () => {
  assert.deepEqual(startEpoch(0, 5), { ok: true, epoch: 6 });
  assert.deepEqual(startEpoch(7, 5), { ok: true, epoch: 8 });
  assert.deepEqual(startEpoch(0, undefined), { ok: true, epoch: 1 });
  assert.deepEqual(startEpoch(3, 1, 9), { ok: true, epoch: 10 }, 'above the newest stamp');
  for (const bad of [-1, 1.5, Number.NaN, '4', null]) assert.deepEqual(startEpoch(0, bad), { ok: false, code: 'floor_invalid' });
  assert.deepEqual(startEpoch(0, 65), { ok: false, code: 'floor_too_high' });
  assert.deepEqual(startEpoch(0, Number.MAX_SAFE_INTEGER), { ok: false, code: 'floor_too_high' });
  assert.deepEqual(startEpoch(1_000_000_000, 0), { ok: false, code: 'epoch_limit' });
});

test('a Host says what it holds with or without a grant, and an unreadable record is no answer', () => {
  const home = running('A', 2) as any;
  assert.equal(lookOf(home, false).holds, 'home');
  assert.equal(lookOf(home, false).grantLive, false);
  assert.equal(lookOf({ ...home, state: 'moving' }, true).holds, 'home');
  assert.equal(lookOf({ ...home, state: 'none' }, true).holds, 'none');
  assert.equal(lookOf({ ...home, state: 'none', movedTo: { name: 'B', homeId: 'B', at: 1 } }, true).holds, 'moved');
  assert.equal(
    lookOf({ ...home, state: 'none', movedTo: { name: 'B', homeId: 'B', at: 1 }, retired: { at: 5, lastActive: 4 } }, true).holds,
    'retired',
  );
  assert.equal(lookOf(null, true).holds, 'unreadable');
});

test('a release is read strictly: "dev", "local", an empty or garbage version, or a build id is never "older than the first home"', () => {
  assert.deepEqual(releaseOf('0.4.60'), [0, 4, 60]);
  for (const bad of ['dev', 'local', '', 'garbage', '0.4', '0.4.60-rc1', '1.2.x', 'abc123def456', null, undefined, 4]) {
    assert.equal(releaseOf(bad), null, String(bad));
    assert.equal(olderRelease(bad, '0.4.60'), false, String(bad));
  }
  assert.equal(olderRelease('0.4.59', '0.4.60'), true);
  assert.equal(olderRelease('0.4.60', '0.4.60'), false);
  assert.equal(olderRelease('0.5.0', '0.4.60'), false);
});

test('the client reads what a machine said with no guessing: a machine with no Host, a Host too old to hold a home, a Host that cannot be asked, a look not made yet, and anything malformed or unknown', () => {
  const base = {
    id: 'x',
    hasHost: true,
    reachable: true,
    lookFeature: true,
    version: '9.9.9',
    versionFresh: true,
    look: lookOf({ ...none() } as any, true) as any,
  };
  const d = (o: object) => decide([{ ...base, ...o }], { seen: 0 });
  assert.equal(d({ look: undefined }).offerStartFresh, false, 'nothing is offered before every reachable Host has been looked at');
  assert.equal(d({ look: undefined }).offerChoose, false);
  assert.equal(d({ hasHost: false }).offerChoose, true);
  assert.equal(d({ lookFeature: false, version: '0.4.59' }).offerChoose, true);
  for (const version of ['0.4.60', 'dev', 'local', '', null, 'garbage', 'abc123'])
    assert.deepEqual(d({ lookFeature: false, version }).unheard, ['x'], `${version} may hold a home`);
  assert.deepEqual(d({ lookFeature: false, version: '0.4.59', versionFresh: false }).unheard, ['x'], 'a stale version is not trusted');
  assert.deepEqual(d({ reachable: false }).unheard, ['x']);
  for (const look of [
    null,
    { holds: 'unreadable', grantLive: true },
    { holds: 'surprise', leaseEpoch: 1 },
    { holds: 'home', homeId: 'x' },
    { holds: 'none', leaseEpoch: Number.NaN },
    { holds: 'home', homeId: 'x', leaseEpoch: -1 },
    { holds: 'moved', leaseEpoch: 1 },
    'text',
  ])
    assert.deepEqual(d({ look }).unheard, ['x'], JSON.stringify(look));
  const h = d({ look: { holds: 'home', homeId: 'x', leaseEpoch: 4, name: 'X', state: 'running', grantLive: false } });
  assert.deepEqual([h.winner, h.floor, h.offerChoose, h.offerStartFresh], ['x', 4, false, false]);
  assert.ok(Number.isFinite(d({ look: { holds: 'none', leaseEpoch: 3, grantLive: true } }).floor));
  assert.equal(decide([{ ...base }], { seen: Number.NaN as any }).floor, 0, 'a memory that is not an epoch is none');
});

test('"Delete the old MoMo" on a record nobody could read is a typed refusal, not a crash', () => {
  assert.equal(resetRule(null, { ifRetired: true, expectEpoch: 3 })?.code, 'retired_changed');
  assert.equal(resetRule(null, undefined), null, 'a plain Reset has no precondition to fail');
});

test('a look the client cannot trust in one detail is read without guessing: a home with no name, a moved or retired look whose target is not a home id, a retired look with no time, and a stand-down step with no own epoch', async () => {
  const base = { id: 'x', hasHost: true, reachable: true, lookFeature: true, version: '9.9.9', versionFresh: true };
  const answer = (look: any) => answerOf({ ...base, look } as any);
  assert.deepEqual(
    (answer({ holds: 'home', homeId: 'h', leaseEpoch: 2, state: 'running', grantLive: true }) as any).name,
    '',
    'a home with no name has an empty one',
  );
  for (const holds of ['moved', 'retired'])
    assert.equal(
      answer({ holds, leaseEpoch: 3, movedTo: { name: 'M', homeId: 7, at: 1 }, grantLive: true }).kind,
      'unheard',
      `${holds} naming no home id`,
    );
  assert.equal(
    (answer({ holds: 'retired', leaseEpoch: 3, movedTo: { name: 'M', homeId: 'm', at: 1 }, grantLive: true }) as any).lastActive,
    0,
  );
  // a stand-down step that carries no `own` climbs from the target itself
  const calls: number[] = [];
  const ran = await execute([{ call: 'host.momoStandDown', host: 'a', params: { homeId: 'b', leaseEpoch: 5 } }], async (step: any) => {
    calls.push(step.params.leaseEpoch);
    return { ok: true, leaseEpoch: step.params.leaseEpoch };
  });
  assert.equal(ran.ok, true);
  assert.deepEqual(calls, [5]);
});

test('a stand-down with no lease to give and no start before it stops with a typed answer and calls nobody', async () => {
  let called = 0;
  const ran = await execute(
    [{ call: 'host.momoStandDown', host: 'a', params: { homeId: 'b', leaseEpoch: null } }],
    async () => (called++, { ok: true, leaseEpoch: 1 }),
  );
  assert.deepEqual([ran.ok, (ran as any).code, called], [false, 'no_lease', 0]);
});

test('the steps that create a home climb from the machine’s own epoch when it is known, and from none when it is not; a start answer without a home id leaves the stand-down’s own', async () => {
  const d = decide(
    [
      {
        id: 'x',
        hasHost: true,
        reachable: true,
        lookFeature: true,
        version: '9.9.9',
        versionFresh: true,
        look: lookOf(none() as any, true) as any,
      },
    ],
    { seen: 300 },
  );
  assert.equal(
    (createSteps(d, { id: 'x', name: 'X', own: 250 })[0]!.params as any).floor,
    300,
    'from the machine’s own epoch: 250 + 64 reaches the floor',
  );
  assert.equal((createSteps(d, { id: 'x', name: 'X' })[0]!.params as any).floor, 64, 'from none: one step of the bound');
  const sent: any[] = [];
  const ran = await execute(
    [
      { call: 'host.momoHomeStart', host: 'b', params: { name: 'b', floor: 1, climbTo: 1 } },
      { call: 'host.momoHomeStart', host: 'b', params: { name: 'b', floor: 1, climbTo: 1 } },
      { call: 'host.momoStandDown', host: 'a', params: { homeId: '', leaseEpoch: null } },
    ],
    async (step: any) => (
      sent.push(step),
      step.call === 'host.momoHomeStart' && sent.length === 1 ? { ok: true, leaseEpoch: 5, homeId: 'h1' } : { ok: true, leaseEpoch: 5 }
    ),
  );
  assert.equal(ran.ok, true);
  assert.equal(sent.at(-1).params.homeId, 'h1', 'a later start that names no home leaves the one an earlier start named');
});
