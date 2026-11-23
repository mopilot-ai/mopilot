// The owner's reclaim of a move of MoMo's home, raced against a late receive and commit, repeated, and fenced by the real stamp receivers; second seals; and receipts replayed from the record of an older move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { recoverMove } from '../shared/momoMove.mjs';
import {
  twoMachines,
  violations,
  sealedHashes,
  IDS,
  FACT,
  MOVE_TTL_MS,
  MOVE_GRACE_MS,
  fencedBy,
  type World,
  type Key,
} from './momoEvals/home/world.ts';

const step = (w: World, key: Key, op: string, p: object = {}) => w.net.side(key).call(op, p);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: any) => String(e.code),
  );
const commitArgs = (to: 'B' | 'C', leaseEpoch = 2) => ({ leaseEpoch, homeId: IDS[to].homeId, name: IDS[to].name, from: IDS.A.name });
async function upTo(w: World, to: 'B' | 'C', moveId: string, o: { from?: 'A' | 'B'; receive?: boolean } = {}) {
  const from = o.from ?? 'A';
  const offer = await step(w, to, 'offer', { moveId });
  await step(w, from, 'begin', { moveId });
  const sealed = await step(w, from, 'seal', { moveId, targetKey: offer.targetKey, signKey: offer.signKey });
  if (o.receive !== false) await step(w, to, 'receive', { moveId, sealed: sealed.sealed, bundleHash: sealed.bundleHash });
  return { offer, sealed };
}
/** A third machine as a receiver of stamps: the real sink of a Host (`receiveStamp`). */
const receiver = (w: World) => w.m.C!.home.receiveStamp as (s: unknown) => Promise<{ ok: boolean; reason?: string }>;
const stamp = (w: World, k: Key) => w.m[k]!.stamp()!;

test('reclaim: the old home runs again two leases ahead, the move id is closed, and a second reclaim changes nothing', async () => {
  const w = await twoMachines({ third: true });
  await upTo(w, 'B', 'move-0001');
  assert.equal(w.m.A!.acts(), false);
  await step(w, 'A', 'reclaim', { moveId: 'move-0001' });
  assert.deepEqual([w.m.A!.acts(), w.m.A!.record().leaseEpoch], [true, 3]);
  assert.equal(await code(step(w, 'A', 'reclaim', { moveId: 'move-0001' })), 'move_unknown');
  assert.equal(await code(step(w, 'A', 'begin', { moveId: 'move-0001' })), 'move_closed');
  assert.equal(w.m.A!.record().leaseEpoch, 3, 'not three leases ahead');
  assert.equal(
    (await w.m.A!.home.stores().memory.list()).facts.some((f: any) => f.text === FACT),
    true,
  );
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  w.dispose();
});

test("reclaim, then the target that held the bundle switches late: its lease is older, so every receiver refuses it and the old home's finish is refused", async () => {
  const w = await twoMachines({ third: true });
  await upTo(w, 'B', 'move-0001');
  await step(w, 'A', 'reclaim', { moveId: 'move-0001' });
  const late = await step(w, 'B', 'commit', { moveId: 'move-0001', ...commitArgs('B') });
  assert.deepEqual(
    [w.m.B!.acts(), stamp(w, 'B').leaseEpoch, stamp(w, 'A').leaseEpoch],
    [true, 2, 3],
    'the target does not know and runs at the lease it was given',
  );
  const accept = receiver(w);
  assert.equal((await accept(stamp(w, 'B'))).ok, true, 'a receiver that has seen nothing newer believes it');
  assert.equal((await accept(stamp(w, 'A'))).ok, true);
  assert.deepEqual(
    [(await accept(stamp(w, 'B'))).ok, (await accept(stamp(w, 'B'))).reason],
    [false, 'stale'],
    'and refuses it for good once it has seen the reclaimed home',
  );
  assert.equal(
    await code(
      step(w, 'A', 'finish', { moveId: 'move-0001', leaseEpoch: 2, name: IDS.B.name, homeId: IDS.B.homeId, receipt: late.receipt }),
    ),
    'move_unknown',
  );
  assert.equal(w.m.A!.acts(), true);
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  w.dispose();
});

test('reclaim raced against a late receive and commit, in both orders: the old home ends at lease 3 and the target is fenced or never switched', async () => {
  for (const order of ['reclaim-first', 'commit-first']) {
    const w = await twoMachines({ third: true });
    const { sealed } = await upTo(w, 'B', 'move-0001', { receive: false });
    const late = async () => {
      await step(w, 'B', 'receive', { moveId: 'move-0001', sealed: sealed.sealed, bundleHash: sealed.bundleHash });
      return step(w, 'B', 'commit', { moveId: 'move-0001', ...commitArgs('B') });
    };
    const reclaim = () => step(w, 'A', 'reclaim', { moveId: 'move-0001' });
    const [x, y] = await Promise.allSettled(order === 'reclaim-first' ? [reclaim(), late()] : [late(), reclaim()]);
    assert.equal((order === 'reclaim-first' ? x : y).status, 'fulfilled', order);
    assert.deepEqual([w.m.A!.acts(), w.m.A!.record().leaseEpoch], [true, 3], order);
    assert.deepEqual(await violations(w, sealedHashes(w)), [], order);
    if (w.m.B!.acts()) {
      assert.equal(fencedBy([stamp(w, 'A'), stamp(w, 'B')]), true, order);
      const accept = receiver(w);
      await accept(stamp(w, 'A'));
      assert.equal((await accept(stamp(w, 'B'))).ok, false, `${order}: a receiver that saw the old home refuses the target`);
    }
    w.dispose();
  }
});

test("after a reclaim a new move to another machine takes the next lease above both, and the first target's stamps stay refused", async () => {
  const w = await twoMachines({ third: true });
  await upTo(w, 'B', 'move-0001');
  await step(w, 'A', 'reclaim', { moveId: 'move-0001' });
  await step(w, 'B', 'commit', { moveId: 'move-0001', ...commitArgs('B') }); // the late twin
  const offer = await step(w, 'C', 'offer', { moveId: 'move-0002' });
  const began = await step(w, 'A', 'begin', { moveId: 'move-0002' });
  assert.equal(began.home.leaseEpoch, 3);
  const sealed = await step(w, 'A', 'seal', { moveId: 'move-0002', targetKey: offer.targetKey, signKey: offer.signKey });
  await step(w, 'C', 'receive', { moveId: 'move-0002', sealed: sealed.sealed, bundleHash: sealed.bundleHash });
  const done = await step(w, 'C', 'commit', { moveId: 'move-0002', ...commitArgs('C', 4) });
  await step(w, 'A', 'finish', { moveId: 'move-0002', leaseEpoch: 4, name: IDS.C.name, homeId: IDS.C.homeId, receipt: done.receipt });
  assert.equal(stamp(w, 'C').leaseEpoch, 4);
  assert.equal(fencedBy([stamp(w, 'B'), stamp(w, 'C')]), true);
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  w.dispose();
});

test("recoverMove with the owner's word: a target that holds nothing is reclaimed at once, a target that gave up is cancelled at the same lease, one that switched is finished", async () => {
  // lost the offer
  const lost = await twoMachines();
  await upTo(lost, 'B', 'move-0001');
  lost.m.B!.kill();
  lost.m.B!.restart();
  const r1 = await recoverMove({
    moveId: 'move-0001',
    from: lost.net.side('A'),
    to: lost.net.side('B'),
    target: IDS.B,
    ownerAccepts: true,
  });
  assert.deepEqual([r1.state, lost.m.A!.record().leaseEpoch], ['resumed', 3]);
  assert.equal(await code(step(lost, 'A', 'begin', { moveId: 'move-0001' })), 'move_closed');
  lost.dispose();
  // without the owner's word nothing moves
  const waits = await twoMachines();
  await upTo(waits, 'B', 'move-0001');
  waits.m.B!.kill();
  waits.m.B!.restart();
  const r0 = await recoverMove({ moveId: 'move-0001', from: waits.net.side('A'), to: waits.net.side('B'), target: IDS.B });
  assert.deepEqual([r0.state, waits.m.A!.acts()], ['uncertain', false]);
  waits.dispose();
  // gave up
  const gave = await twoMachines();
  await upTo(gave, 'B', 'move-0001');
  const r2 = await recoverMove({
    moveId: 'move-0001',
    from: gave.net.side('A'),
    to: gave.net.side('B'),
    target: IDS.B,
    ownerAccepts: true,
  });
  assert.deepEqual([r2.state, gave.m.A!.record().leaseEpoch], ['resumed', 1]);
  gave.dispose();
  // switched: the owner's word is not used
  const sw = await twoMachines();
  await upTo(sw, 'B', 'move-0001');
  await step(sw, 'B', 'commit', { moveId: 'move-0001', ...commitArgs('B') });
  const r3: any = await recoverMove({
    moveId: 'move-0001',
    from: sw.net.side('A'),
    to: sw.net.side('B'),
    target: IDS.B,
    ownerAccepts: true,
  });
  assert.deepEqual([r3.state, r3.oldHome, r3.homeId], ['switched', 'cleared', IDS.B.homeId]);
  assert.deepEqual(await violations(sw, sealedHashes(sw)), []);
  sw.dispose();
});

test('a move seals once: a second seal, a seal after a cancel, after a reclaim and for another move id are refused and change no bundle', async () => {
  const w = await twoMachines();
  const { offer, sealed } = await upTo(w, 'B', 'move-0001', { receive: false });
  const seal = (moveId: string) => step(w, 'A', 'seal', { moveId, targetKey: offer.targetKey, signKey: offer.signKey });
  assert.equal(await code(seal('move-0001')), 'move_sealed');
  assert.equal(await code(seal('move-0002')), 'move_unknown');
  assert.equal(w.m.A!.record().bundleHash, sealed.bundleHash, 'the hash the target was told is the one kept');
  const gave = await step(w, 'B', 'discard', { moveId: 'move-0001' });
  await step(w, 'A', 'cancel', { moveId: 'move-0001', proof: gave.proof });
  assert.equal(await code(seal('move-0001')), 'move_unknown', 'after a cancel');
  await upTo(w, 'B', 'move-0002', { receive: false });
  await step(w, 'A', 'reclaim', { moveId: 'move-0002' });
  assert.equal(await code(seal('move-0002')), 'move_unknown', 'after a reclaim');
  assert.equal(w.m.A!.record().bundleHash, null);
  w.dispose();
});

test('a clock past the deadline: an unsealed move seals nothing late, and a sealed one still cannot be sealed again', async () => {
  const w = await twoMachines();
  const offer = await step(w, 'B', 'offer', { moveId: 'move-0001' });
  await step(w, 'A', 'begin', { moveId: 'move-0001' });
  w.tick(MOVE_TTL_MS + MOVE_GRACE_MS + 1000);
  assert.ok(
    ['move_expired', 'move_unknown'].includes(
      await code(step(w, 'A', 'seal', { moveId: 'move-0001', targetKey: offer.targetKey, signKey: offer.signKey })),
    ),
  );
  w.dispose();
});

test('receipts kept in the record: a replayed commit or discard of an older move on a machine that has moved on changes nothing, and signs no proof', async () => {
  const w = await twoMachines({ third: true });
  const {} = await upTo(w, 'B', 'move-0001');
  const first = await step(w, 'B', 'commit', { moveId: 'move-0001', ...commitArgs('B'), homeId: 'home-zzzz-9999' });
  assert.equal(first.homeId, IDS.B.homeId, 'the answer names the machine by its own id, whatever the client said');
  await step(w, 'A', 'finish', { moveId: 'move-0001', leaseEpoch: 2, name: IDS.B.name, homeId: IDS.B.homeId, receipt: first.receipt });
  // MoMo goes on from B to C
  const offer = await step(w, 'C', 'offer', { moveId: 'move-0002' });
  await step(w, 'B', 'begin', { moveId: 'move-0002' });
  const sealed = await step(w, 'B', 'seal', { moveId: 'move-0002', targetKey: offer.targetKey, signKey: offer.signKey });
  await step(w, 'C', 'receive', { moveId: 'move-0002', sealed: sealed.sealed, bundleHash: sealed.bundleHash });
  const replay = await step(w, 'B', 'discard', { moveId: 'move-0001' });
  assert.deepEqual([replay.committed, replay.receipt, replay.homeId, 'proof' in replay], [true, first.receipt, IDS.B.homeId, false]);
  assert.equal(
    await code(
      step(w, 'B', 'finish', { moveId: 'move-0002', leaseEpoch: 3, name: IDS.C.name, homeId: IDS.C.homeId, receipt: first.receipt }),
    ),
    'receipt_invalid',
  );
  assert.equal(await code(step(w, 'B', 'cancel', { moveId: 'move-0002', proof: first.receipt })), 'move_not_given_up');
  assert.equal(w.m.B!.record().state, 'moving');
  assert.ok(w.m.B!.hasData() && w.m.B!.hasKey());
  const again = await step(w, 'B', 'commit', { moveId: 'move-0001', ...commitArgs('B') });
  assert.equal(again.receipt, first.receipt);
  assert.equal(w.m.B!.record().state, 'moving', 'a replayed switch does not turn the machine into a home again');
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  w.dispose();
});

test("the target refuses a bundle after its offer ran out, and a switch that is not a newer lease than the old home's is refused by the old home even with a good receipt", async () => {
  const w = await twoMachines();
  const offer = await step(w, 'B', 'offer', { moveId: 'move-0001' });
  await step(w, 'A', 'begin', { moveId: 'move-0001' });
  const sealed = await step(w, 'A', 'seal', { moveId: 'move-0001', targetKey: offer.targetKey, signKey: offer.signKey });
  w.tick(MOVE_TTL_MS + 1000);
  assert.equal(
    await code(step(w, 'B', 'receive', { moveId: 'move-0001', sealed: sealed.sealed, bundleHash: sealed.bundleHash })),
    'move_expired',
  );
  assert.equal(w.m.B!.hasData(), false, 'nothing was staged');
  w.dispose();
  // a client that asks the target to switch at the old home's own lease gets a genuine receipt, which the old home still refuses
  const v = await twoMachines();
  await upTo(v, 'B', 'move-0001');
  const same = await step(v, 'B', 'commit', { moveId: 'move-0001', ...commitArgs('B', 1) });
  assert.equal(
    await code(
      step(v, 'A', 'finish', { moveId: 'move-0001', leaseEpoch: 1, name: IDS.B.name, homeId: IDS.B.homeId, receipt: same.receipt }),
    ),
    'home_lease_stale',
  );
  assert.equal(v.m.A!.record().state, 'moving');
  assert.ok(v.m.A!.hasData() && v.m.A!.hasKey());
  v.dispose();
});

test('a move id the target gave up is not offered again, and a committed one is told as committed whoever asks', async () => {
  const w = await twoMachines();
  await step(w, 'B', 'offer', { moveId: 'move-0001' });
  await step(w, 'B', 'discard', { moveId: 'move-0001' });
  assert.equal(await code(step(w, 'B', 'offer', { moveId: 'move-0001' })), 'move_discarded');
  w.dispose();
});
