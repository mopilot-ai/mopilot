// Model test of "at most one live home": three Hosts and two clients (the Mac and the phone, each with its own memory) following the shared client rules over the Host's own pure rules, through every order of up to three events (restart with no memory, an unreachable or unreadable Host, a lapsed grant, a stamp seen, Reset, Start fresh and a client that crashes after the Host started, accept-lease, taking a retired home back, a move that begins and commits). Invariants on EVERY step: after a client syncs, at most one live home among the Hosts that answer and none at one epoch; a client never offers to create a home while one may exist; a retired home keeps its data and every stand-down is at a lease some Host granted. Named scenarios cover longer sequences. The model's world and events are in tests/support/momoHomeModel.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore
import { createSteps, decide, execute } from '../shared/host/momoHomeClient.mjs';
// @ts-ignore
import { adoptRule, lookOf } from '../shared/host/momoHomeSafety.mjs';
import {
  check,
  checkSynced,
  clone,
  events,
  fresh,
  hostStandDown,
  hostStart,
  live,
  machines,
  none,
  run,
  running,
  sync,
} from './support/momoHomeModel.ts';
import type { World } from './support/momoHomeModel.ts';
const ORDERS: [string, string, string][] = [
  ['a', 'b', 'c'],
  ['c', 'b', 'a'],
];

test('every order of up to three events keeps at most one live home, never offers to create over one and never loses a retired home’s data', async () => {
  let paths = 0;
  for (const ids of ORDERS) {
    const evs = events([0, 1, 2]);
    const walk = async (w: World, depth: number, trail: string[]) => {
      paths++;
      check(w, trail);
      await checkSynced(w, 0, trail);
      await checkSynced(w, 1, trail);
      if (depth === 0) return;
      for (const e of evs) {
        const next = clone(w);
        await e.run(next);
        await walk(next, depth - 1, [...trail, e.label]);
      }
    };
    await walk(fresh(ids), 3, []);
  }
  assert.ok(paths > 100_000, `walked ${paths} paths`);
});

/** A sequence run as written, with the per-step invariants after each. */
async function scenario(ids: [string, string, string], steps: string[], hosts = [0, 1, 2]) {
  const evs = events(hosts);
  const w = fresh(ids);
  const trail: string[] = [];
  for (const label of steps) {
    const e = evs.find((x) => x.label === label);
    assert.ok(e, `no event "${label}"`);
    await e.run(w);
    trail.push(label);
    check(w, trail);
  }
  return w;
}
const CREATE = (c: number, h: number) => `client ${c} starts a home on Host ${h} (choose, or Start fresh after the owner confirmed)`;

test('Start fresh while the real MoMo is away: when it returns it is retired with its data kept, and the owner can take it back above the new one', async () => {
  for (const ids of ORDERS) {
    const w = await scenario(ids, ['Host 0 unreachable', CREATE(0, 1), 'Host 0 reachable', 'client 0 syncs']);
    assert.deepEqual(
      w.hosts.map((h) => live(h)),
      [false, true, false],
    );
    assert.ok(w.hosts[0]!.rec.retired && w.hosts[0]!.data, 'retired, data kept');
    const d = decide(machines(w), w.clients[0]!);
    assert.deepEqual(
      d.older.map((o: any) => o.host),
      [ids[0]],
      'the owner is told once about the older MoMo',
    );
    await scenario(ids, [
      'Host 0 unreachable',
      CREATE(0, 1),
      'Host 0 reachable',
      'client 0 syncs',
      'client 0 takes back the retired home on Host 0',
      'client 1 syncs',
    ]).then((back) => {
      assert.deepEqual(
        back.hosts.map((h) => live(h)),
        [true, false, false],
        'the older MoMo runs again, above the new one',
      );
      assert.ok(back.hosts[1]!.rec.retired && back.hosts[1]!.data, 'and the new one is retired with its data kept');
      assert.ok(back.hosts[0]!.rec.leaseEpoch >= back.hosts[1]!.rec.leaseEpoch, 'the retired one carries the winner’s lease');
      assert.ok(back.hosts[0]!.rec.leaseEpoch > 2, 'above the home it replaced');
    });
  }
});

test('a client that restarted with no memory and starts fresh at the same epoch as the old home: the greater id keeps MoMo and the other is retired, whichever it is', async () => {
  for (const ids of ORDERS) {
    const w = await scenario(ids, ['client 0 restarts with no memory', 'Host 0 unreachable', CREATE(0, 1), 'Host 0 reachable']);
    assert.equal(w.hosts.filter(live).length, 2, 'two homes before anyone looked: the state the tie-break resolves');
    await sync(w, 1);
    const alive = w.hosts.filter(live);
    assert.deepEqual(
      alive.map((h) => h.id),
      [ids[0] > ids[1] ? ids[0] : ids[1]],
    );
    assert.ok(alive[0]!.rec.leaseEpoch > 1, 'it took a new lease above the tie');
    assert.ok(w.hosts.filter((h) => h.rec.retired).every((h) => h.data));
  }
});

test('the Mac and the phone both Start fresh on different Hosts at the same floor: one keeps MoMo', async () => {
  for (const ids of ORDERS) {
    const w = await scenario(ids, [
      'Host 0 unreachable',
      'client 0 restarts with no memory',
      'client 1 restarts with no memory',
      CREATE(0, 1),
    ]);
    w.hosts[0]!.reachable = true;
    await sync(w, 0);
    await sync(w, 1);
    assert.equal(w.hosts.filter(live).length, 1);
  }
});

test('a move overtaken by Start fresh on a third machine: the target commits below the new home, the home is retired and nothing is lost', async () => {
  for (const ids of ORDERS) {
    const w = await scenario(ids, [
      'the home begins a move to Host 1',
      'Host 0 unreachable',
      CREATE(0, 2),
      'Host 0 reachable',
      'client 0 syncs',
    ]);
    assert.ok(w.hosts[0]!.rec.retired && w.hosts[0]!.data, 'the moving home was retired with its data kept');
    const d = decide(machines(w), w.clients[0]!);
    assert.equal(d.replaced.length, 0, 'nothing left to replace after the sync');
    // the owner is told about the replaced move on the sync that retired it
    const again = await scenario(ids, ['the home begins a move to Host 1', 'Host 0 unreachable', CREATE(0, 2), 'Host 0 reachable']);
    const told = decide(machines(again), again.clients[0]!);
    assert.deepEqual(
      told.replaced.map((r: any) => [r.host, r.moving]),
      [[ids[0], true]],
    );
    // the target commits at an epoch below the new home: it is retired too, never a second live home
    await events([0, 1, 2])
      .find((e) => e.label === 'the move commits on its target, and the old home finishes')!
      .run(again);
    await sync(again, 0);
    assert.ok(again.hosts.filter(live).length <= 1);
  }
});

test('accept-lease: the owner keeps the older copy; it takes a new lease above the newer one, which stands down, and the newer one returning later does not undo it', async () => {
  for (const ids of ORDERS) {
    const w = fresh(ids);
    w.hosts[1]!.rec = running(ids[1], 3);
    w.hosts[1]!.data = true;
    w.clients[0] = { seen: 3, chosen: ids[0] };
    await sync(w, 0);
    assert.deepEqual(
      w.hosts.filter(live).map((h) => h.id),
      [ids[0]],
    );
    assert.ok(w.hosts[0]!.rec.leaseEpoch > 3);
    assert.ok(w.hosts[1]!.rec.retired && w.hosts[1]!.data);
    const again = fresh(ids);
    again.hosts[1]!.rec = running(ids[1], 3);
    again.hosts[1]!.reachable = false;
    again.clients[0] = { seen: 3, chosen: ids[0] };
    await sync(again, 0);
    again.hosts[1]!.reachable = true;
    await sync(again, 0);
    assert.deepEqual(
      again.hosts.filter(live).map((h) => h.id),
      [ids[0]],
    );
  }
});

test('a grant that lapsed on the home does not make it look like "no home": a client never offers to create beside it', async () => {
  for (const ids of ORDERS) await scenario(ids, ['Host 0 grant lapses', 'client 0 restarts with no memory', CREATE(0, 1)]);
  const w = await scenario(['a', 'b', 'c'], ['Host 0 grant lapses', CREATE(0, 1)]);
  assert.equal(w.hosts[1]!.rec.state, 'none', 'nothing was created');
});

test('a tombstone naming a home nobody holds now is not "no home": plain choose is not offered, Start fresh is, and it starts above the tombstone’s epoch', async () => {
  const w = await scenario(
    ['a', 'b', 'c'],
    [
      'the home begins a move to Host 1',
      'the move commits on its target, and the old home finishes',
      'Host 1 is Reset (record kept, tombstone and retirement cleared, epoch kept, data deleted)',
    ],
  );
  const d = decide(machines(w), w.clients[0]!);
  assert.equal(d.homes.length, 0);
  assert.equal(d.offerChoose, false);
  assert.equal(d.offerStartFresh, true);
  assert.deepEqual(d.moved, ['a']);
  await run(w, createSteps(d, { id: 'b', name: 'b', own: w.hosts[1]!.rec.leaseEpoch }));
  assert.ok(w.hosts[1]!.rec.leaseEpoch > w.hosts[0]!.rec.leaseEpoch, 'above the tombstone’s epoch');
});

const RETIRE_0 = ['Host 0 unreachable', CREATE(0, 1), 'Host 0 reachable', 'client 0 syncs'];

test('"Delete the old MoMo" racing a revive: the delete is refused once the copy runs again, and nothing live is wiped', async () => {
  for (const ids of ORDERS) {
    const w = await scenario(ids, [
      ...RETIRE_0,
      'client 0 confirms "Delete the old MoMo" on Host 0 (it saw the copy retired)',
      'client 1 takes back the retired home on Host 0',
    ]);
    assert.ok(live(w.hosts[0]!), 'the other client took it back');
    await events([0, 1, 2])
      .find((e) => e.label === `client 0's delete of the old MoMo on Host 0 reaches it`)!
      .run(w);
    assert.ok(live(w.hosts[0]!) && w.hosts[0]!.data, 'the delete found a running home and did nothing');
    // and without the race the delete wipes only that copy
    const plain = await scenario(ids, [
      ...RETIRE_0,
      'client 0 confirms "Delete the old MoMo" on Host 0 (it saw the copy retired)',
      `client 0's delete of the old MoMo on Host 0 reaches it`,
    ]);
    assert.deepEqual(
      [plain.hosts[0]!.data, plain.hosts[0]!.rec.retired, live(plain.hosts[1]!)],
      [false, null, true],
      'only the retired copy is gone; the current home is untouched',
    );
  }
});

test('a move offered to a machine that keeps a retired copy is refused, and an adopt there is refused too: the two sets of data are never mixed', async () => {
  for (const ids of ORDERS) {
    const w = await scenario(ids, [...RETIRE_0]);
    // the current home is on Host 1; a move to the retired Host 0 must not begin
    await events([0, 1, 2])
      .find((e) => e.label === 'the home begins a move to Host 0')!
      .run(w);
    assert.equal(w.hosts[1]!.rec.state, 'running', 'no move began');
    assert.equal(adoptRule(w.hosts[0]!.rec as any, 99, 0)?.code, 'retired_copy_here');
    assert.ok(w.hosts[0]!.data);
  }
});

test('a winner that is moving is never re-leased: decide waits and says so, no steps run, and a start of the moving home is answered as it is', async () => {
  const w = fresh(['c', 'b', 'a']);
  w.hosts[1]!.rec = running('b', 1);
  w.hosts[1]!.data = true;
  Object.assign(w.hosts[0]!.rec, { state: 'moving', moveId: 'm1', bundleHash: 'h', targetSignKey: 'k' });
  const d = decide(machines(w), w.clients[0]!);
  assert.deepEqual(d.steps, []);
  assert.equal(d.blocked?.kind, 'move-in-progress');
  assert.equal(live(w.hosts[0]!) && live(w.hosts[1]!), true, 'nothing was retired while the move runs');
  // when the move ends, the next look decides again
  Object.assign(w.hosts[0]!.rec, { state: 'running', moveId: null });
  assert.equal(decide(machines(w), w.clients[0]!).blocked, null);
});

test('a stand-down is climbed to a far winner: a Host takes a lease only so far above what it knows, so the loser is retired in steps and ends at the winner’s real lease', async () => {
  const w = fresh(['a', 'b', 'c']);
  w.hosts[1]!.rec = running('b', 700);
  w.hosts[1]!.data = true;
  w.clients[0] = { seen: 700, chosen: null };
  const d = decide(machines(w), w.clients[0]!);
  assert.equal(d.winner, 'b');
  const calls: number[] = [];
  const ran = await execute(d.steps, async (step: any) => {
    const r: any = step.call === 'host.momoStandDown' ? hostStandDown(w.hosts[0]!, step.params) : hostStart(w, w.hosts[1]!, step.params);
    if (step.call === 'host.momoStandDown') calls.push(step.params.leaseEpoch);
    return r;
  });
  assert.equal(ran.ok, true);
  assert.ok(calls.length > 5, `climbed in ${calls.length} stand-downs`);
  assert.ok(
    calls.every((c, i) => i === 0 || c > calls[i - 1]!),
    'each step goes higher',
  );
  assert.deepEqual([w.hosts[0]!.rec.leaseEpoch, w.hosts[0]!.rec.retired !== null, w.hosts[0]!.data], [700, true, true]);
  assert.ok(!live(w.hosts[0]!), 'the returning home no longer acts beside the new one');
});

test('the machine picker: a plain choose shows it; Start fresh asks first, and once confirmed shows it, so it never loops back to the question', () => {
  const none0 = {
    id: 'x',
    hasHost: true,
    reachable: true,
    lookFeature: true,
    version: '9.9.9',
    versionFresh: true,
    look: lookOf(none() as any, true) as any,
  };
  const silent = { ...none0, id: 'y', reachable: false };
  assert.equal(decide([none0], { seen: 0 }).picker, 'choose');
  assert.equal(decide([none0, silent], { seen: 0 }).picker, 'confirm');
  assert.equal(decide([none0, silent], { seen: 0, freshConfirmed: true }).picker, 'fresh');
  assert.equal(decide([{ ...none0, look: undefined }], { seen: 0 }).picker, null, 'nothing before every look is made');
  assert.equal(decide([{ ...none0, look: lookOf(running('x', 2) as any, true) as any }], { seen: 0 }).picker, null, 'never beside a home');
});

test('a stand-down that finds its target already retired or reset ends after one call, never a loop of identical calls', async () => {
  const w = fresh(['a', 'b', 'c']);
  w.hosts[1]!.rec = running('b', 700);
  w.hosts[1]!.data = true;
  w.clients[0] = { seen: 700, chosen: null };
  const d = decide(machines(w), w.clients[0]!);
  // another client retired it for a different winner (or it was reset) before this stand-down arrived
  Object.assign(w.hosts[0]!.rec, { ...none(), leaseEpoch: 1 });
  let calls = 0;
  const ran = await execute(d.steps, async (step: any) => {
    if (step.call === 'host.momoStandDown') calls++;
    return step.call === 'host.momoStandDown' ? hostStandDown(w.hosts[0]!, step.params) : hostStart(w, w.hosts[1]!, step.params);
  });
  assert.equal(ran.ok, true);
  assert.equal(calls, 1, 'one no-progress answer ends it');
});
