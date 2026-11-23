// Races, late and replayed frames, stale epochs, turn replays and reconnects around moving MoMo's home, driven through the real home, move and turn-ledger code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { recoverMove } from '../shared/momoMove.mjs';
import { twoMachines, drive, violations, sealedHashes, observe, IDS, OPEN_TURN, FACT } from './momoEvals/home/world.ts';
import { failures, stepFaults, type Case } from './momoEvals/home/matrix.ts';

test('replaying the whole conversation of a finished move, frame by frame, changes nothing', async () => {
  const w = await twoMachines();
  assert.equal((await drive(w)).ok, true);
  const before = JSON.stringify(observe(w));
  for (const f of w.net.log.filter((l) => l.ok).slice())
    await w.net
      .side(f.machine)
      .call(f.op, f.params)
      .catch(() => undefined);
  assert.equal(JSON.stringify(observe(w)), before);
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  assert.ok((await w.m.B!.home.stores().memory.list()).facts.some((x: any) => x.text === FACT));
  w.dispose();
});

test('a second move while one is under way is refused as "Another move started" and leaves the first alone', async () => {
  const w = await twoMachines({ third: true });
  await w.net.side('A').call('begin', { moveId: 'move-0001' });
  const r = await drive(w, { moveId: 'move-0002', to: 'C' });
  assert.deepEqual([r.ok, r.step, r.code], [false, 'paused', 'move_in_progress']);
  assert.equal(w.m.A!.record().moveId, 'move-0001');
  assert.deepEqual(await violations(w), []);
  w.dispose();
});

test('two moves raced to two targets end with exactly one home', async () => {
  const w = await twoMachines({ third: true });
  const [x, y] = await Promise.all([drive(w, { moveId: 'move-0001', to: 'B' }), drive(w, { moveId: 'move-0002', to: 'C' })]);
  assert.equal([x, y].filter((r: any) => r.ok).length, 1, JSON.stringify([x, y]));
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  assert.equal(observe(w).filter((o) => o.state === 'running').length, 1);
  w.dispose();
});

test('after a move the old stamp is refused by both machines and the new one is honoured; a write that carries the old lease is refused', async () => {
  const w = await twoMachines();
  const old = w.m.A!.stamp()!;
  assert.deepEqual([old.leaseEpoch, w.m.A!.home.current(old)], [1, true]);
  assert.equal((await drive(w)).ok, true);
  const now = w.m.B!.stamp()!;
  assert.equal(now.leaseEpoch, 2);
  assert.deepEqual(
    [w.m.A!.home.current(old), w.m.B!.home.current(old), w.m.B!.home.current(now), w.m.A!.home.current(now)],
    [false, false, true, false],
  );
  assert.equal(w.m.B!.home.current({ homeId: IDS.B.homeId, leaseEpoch: 1 }), false, 'the right machine at an older epoch');
  assert.equal(w.m.A!.stamp(), null);
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  w.dispose();
});

test('a turn the old home had accepted is known to the new one: a reconnecting device is told "interrupted", never "unknown", and a resend is the same turn', async () => {
  const w = await twoMachines();
  assert.equal(await w.sendTurn('A', 'key-00000002', 'claude:c2'), 'run');
  assert.equal(await w.sendTurn('A', 'key-00000002', 'claude:c2'), 'duplicate', 'a resend after a lost answer is the same turn');
  assert.equal((await drive(w)).ok, true);
  for (const id of [OPEN_TURN, 'key-00000002']) {
    assert.equal((await w.m.B!.home.turn(id)).state, 'interrupted', id);
    assert.equal(await w.sendTurn('B', id, id === OPEN_TURN ? 'claude:c1' : 'claude:c2'), 'duplicate', `${id} is not run again`);
  }
  assert.equal(await w.sendTurn('A', 'key-00000003'), 'away', 'the old home takes no turn');
  assert.equal(await w.sendTurn('B', 'key-00000003'), 'run', 'a turn the old home never saw is new');
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  w.dispose();
});

test('a turn sent while the home pauses is either refused or parked, and is never run on both machines', async () => {
  for (const order of ['turn-first', 'pause-first']) {
    const w = await twoMachines();
    const turn = () => w.sendTurn('A', 'key-00000009', 'claude:c9');
    const begin = () => w.net.side('A').call('begin', { moveId: 'move-0001' });
    if (order === 'turn-first') await Promise.all([turn(), begin()]);
    else await Promise.all([begin(), turn()]);
    const rest = await drive(w, { moveId: 'move-0001' });
    assert.equal(rest.ok, true, `${order}: ${JSON.stringify(rest)}`);
    assert.notEqual((await w.m.B!.home.turn('key-00000009')).state, 'accepted', `${order}: nothing is left running on the new home`);
    assert.notEqual(await w.sendTurn('B', 'key-00000009', 'claude:c9'), 'run', `${order}: the turn does not run again`);
    assert.deepEqual(await violations(w, sealedHashes(w)), [], order);
    w.dispose();
  }
});

test('machines whose clocks are minutes apart still park the turn in flight and agree on one home', async () => {
  for (const skewB of [-600_000, 600_000]) {
    const w = await twoMachines({ skewB });
    assert.equal((await drive(w)).ok, true, `skew ${skewB}`);
    assert.equal((await w.m.B!.home.turn(OPEN_TURN)).state, 'interrupted', `skew ${skewB}`);
    assert.deepEqual(await violations(w, sealedHashes(w)), [], `skew ${skewB}`);
    w.dispose();
  }
});

test('frames that arrive late, after the move was rolled back or finished, change nothing that matters (offer, seal, receive, finish)', async () => {
  const cases: Case[] = [];
  for (const [machine, op] of [
    ['B', 'offer'],
    ['A', 'seal'],
    ['B', 'receive'],
    ['A', 'finish'],
  ] as const)
    cases.push({ faults: [{ machine, op, kind: 'delay' }] });
  assert.deepEqual(await failures(cases), []);
});

test("an answer lost after the switch: the move goes on from the target's word and clears the old home with its receipt", async () => {
  const w = await twoMachines();
  w.net.faults = [{ machine: 'B', op: 'commit', kind: 'drop-resp' }];
  const r = await drive(w);
  assert.deepEqual([r.ok, r.oldHome, r.leaseEpoch], [true, 'cleared', 2]);
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  w.dispose();
});

test("the target killed after the switch: nobody runs on a guess, and the app settles it on the target's receipt once it is back", async () => {
  let settled = 0;
  for (let k = 1; k <= 30; k++) {
    const w = await twoMachines();
    w.net.faults = [{ machine: 'B', op: 'commit', kind: 'kill-at', k }];
    const r = await drive(w);
    const killed = !w.m.B!.alive;
    assert.equal(killed ? w.m.A!.acts() : false, false, `k=${k}: the old home does not resume on a guess`);
    w.m.B!.restart();
    if (!killed || w.m.B!.record().state !== 'running') {
      w.dispose();
      continue;
    }
    settled++;
    assert.equal(r.ok, false);
    const net = w.net.side('A');
    const done = await recoverMove({ moveId: 'move-0001', from: net, to: w.net.side('B'), target: IDS.B });
    assert.deepEqual([done.state, (done as any).oldHome], ['switched', 'cleared'], `k=${k}`);
    assert.deepEqual(await violations(w, sealedHashes(w)), [], `k=${k}`);
    w.dispose();
  }
  assert.ok(settled >= 1);
});

test('the same frame sent twice at every step of a move whose first attempt failed leaves one home', async () => {
  const cases: Case[] = [];
  for (const [machine, op] of [
    ['A', 'begin'],
    ['B', 'offer'],
    ['A', 'seal'],
  ] as const)
    for (const c of stepFaults(machine, op, 0).filter((x) => x.faults[0].kind === 'dup' || x.faults[0].kind === 'drop-resp'))
      cases.push({ faults: [...c.faults, { machine: 'B', op: 'receive', kind: 'drop-req' }] });
  assert.deepEqual(await failures(cases), []);
});
