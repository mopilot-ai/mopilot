// Deeper interleavings of moving MoMo's home: two faults in one move, repeated retries without settling, a recovery that is itself cut, and the home moving back and forth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twoMachines, drive, violations, sealedHashes, observe, IDS, FACT, recover } from './momoEvals/home/world.ts';
import { runDeep } from './momoEvals/home/matrix.ts';

test('two faults in one move: twenty-four seeds, then a retry, then a recovery that is cut as well', async () => {
  const problems: string[] = [];
  for (let seed = 1; seed <= 24; seed++) problems.push(...(await runDeep(seed, { faults: 2 })).problems);
  assert.deepEqual(problems, []);
});

test('three faults in one move and retries pressed again without settling: twenty-four more seeds', async () => {
  const problems: string[] = [];
  for (let seed = 101; seed <= 124; seed++) problems.push(...(await runDeep(seed, { faults: 3 })).problems);
  assert.deepEqual(problems, []);
});

test('a seed replays: the same two faults, retries and cut recovery give the same frames', async () => {
  const one = await runDeep(5, { faults: 2 });
  const two = await runDeep(5, { faults: 2 });
  assert.equal(one.trace, two.trace);
});

test('the same move killed at every state change of its first step and again at every state change of the recovery, and the home is whole at the end', async () => {
  for (const op of ['begin', 'seal'] as const) {
    for (let k = 1; k <= 3; k++) {
      for (const rk of [1, 2]) {
        const w = await twoMachines();
        w.net.faults = [{ machine: 'A', op, kind: 'kill-at', k }];
        await drive(w);
        await recover(w, ['move-0001'], { faults: [{ machine: 'A', op: 'cancel', kind: 'kill-at', k: rk }] });
        assert.deepEqual(await violations(w, sealedHashes(w)), [], `${op}@${k} recovery@${rk}`);
        await recover(w, ['move-0001']);
        assert.equal(w.all().filter((m) => m.acts()).length, 1, `${op}@${k} recovery@${rk}`);
        assert.ok(
          (
            await w
              .all()
              .find((m) => m.acts())!
              .home.stores()
              .memory.list()
          ).facts.some((f: any) => f.text === FACT),
        );
        w.dispose();
      }
    }
  }
});

test('three retries in a row to the same target, each cut at a different step, end with one home and a move that goes through', async () => {
  const w = await twoMachines();
  const cuts = [
    { machine: 'B', op: 'receive', kind: 'drop-req' },
    { machine: 'A', op: 'seal', kind: 'drop-resp', nth: 2 },
    { machine: 'B', op: 'commit', kind: 'drop-req' },
  ] as const;
  for (let i = 0; i < cuts.length; i++) {
    w.net.faults = [cuts[i]];
    const r = await drive(w, { moveId: `move-000${i + 1}` });
    assert.equal(r.ok, false, `attempt ${i + 1}`);
    assert.deepEqual(await violations(w, sealedHashes(w)), [], `attempt ${i + 1}`);
  }
  w.net.faults = [];
  await recover(w, ['move-0001', 'move-0002', 'move-0003']);
  const last = await drive(w, { moveId: 'move-0004' });
  assert.equal(last.ok, true, `${last.code}: ${last.message}`);
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  w.dispose();
});

test('the home moves A to B, B to A and A to B again: one home at every epoch, every older stamp refused, the fact and the chain intact', async () => {
  const w = await twoMachines();
  const stamps: { homeId: string; leaseEpoch: number }[] = [w.m.A!.stamp()!];
  const legs = [
    { from: 'A', to: 'B' },
    { from: 'B', to: 'A' },
    { from: 'A', to: 'B' },
  ] as const;
  for (const [i, leg] of legs.entries()) {
    const r = await drive(w, { moveId: `move-000${i + 1}`, from: leg.from, to: leg.to });
    assert.equal(r.ok, true, `leg ${i + 1}: ${r.code}: ${r.message}`);
    assert.equal(r.leaseEpoch, i + 2);
    const now = w.m[leg.to]!.stamp()!;
    for (const old of stamps)
      for (const m of w.all()) assert.equal(m.home.current(old), false, `leg ${i + 1}: ${m.key} honours an old stamp`);
    stamps.push(now);
    assert.deepEqual(await violations(w, sealedHashes(w)), [], `leg ${i + 1}`);
  }
  const home = w.m.B!.home;
  assert.ok((await home.stores().memory.list()).facts.some((f: any) => f.text === FACT));
  assert.equal((await home.stores().audit.verify()).ok, true);
  assert.equal(observe(w).filter((o) => o.acts).length, 1);
  assert.equal(home.stamp().homeId, IDS.B.homeId);
  w.dispose();
});

test('a move back to the machine MoMo left, cut in the middle, leaves one home and the tombstone of the machine that left', async () => {
  const w = await twoMachines();
  assert.equal((await drive(w)).ok, true);
  w.net.faults = [{ machine: 'B', op: 'seal', kind: 'kill-before' }];
  const back = await drive(w, { moveId: 'move-0002', from: 'B', to: 'A' });
  assert.equal(back.ok, false);
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  await recover(w, ['move-0002']);
  assert.equal(w.all().filter((m) => m.acts()).length, 1);
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  w.dispose();
});
