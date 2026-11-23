// Receipts, proofs and deadlines of moving MoMo's home: a receipt or proof from another move, machine, epoch, bundle or world is refused, a sealed move never resumes on a clock, an unsealed one ends itself, and skewed clocks past the deadline never make two homes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { recoverMove } from '../shared/momoMove.mjs';
import { twoMachines, drive, violations, sealedHashes, IDS, MOVE_TTL_MS, MOVE_GRACE_MS, type World } from './momoEvals/home/world.ts';

const step = (w: World, key: 'A' | 'B' | 'C', op: string, p: object = {}) => w.net.side(key).call(op, p);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: any) => String(e.code),
  );
const DEADLINE = MOVE_TTL_MS + MOVE_GRACE_MS;
/** offer, pause, seal, receive (and commit when asked): returns what the app holds. */
async function upTo(w: World, to: 'B' | 'C', moveId: string, commit = false) {
  const offer = await step(w, to, 'offer', { moveId });
  await step(w, 'A', 'begin', { moveId });
  const sealed = await step(w, 'A', 'seal', { moveId, targetKey: offer.targetKey, signKey: offer.signKey });
  await step(w, to, 'receive', { moveId, sealed: sealed.sealed, bundleHash: sealed.bundleHash });
  const switched = commit
    ? await step(w, to, 'commit', { moveId, leaseEpoch: 2, homeId: IDS[to].homeId, name: IDS[to].name, from: IDS.A.name })
    : null;
  return { offer, sealed, switched };
}
const finishWith = (w: World, moveId: string, o: { leaseEpoch?: number; homeId?: string; receipt: string }) =>
  step(w, 'A', 'finish', { moveId, leaseEpoch: o.leaseEpoch ?? 2, name: IDS.B.name, homeId: o.homeId ?? IDS.B.homeId, receipt: o.receipt });

test('a receipt for another epoch, machine or move, and a forged one, never makes the old home delete its copy', async () => {
  const w = await twoMachines({ third: true });
  const { switched } = await upTo(w, 'B', 'move-0001', true);
  const r = switched.receipt as string;
  assert.equal(await code(finishWith(w, 'move-0001', { receipt: r, leaseEpoch: 3 })), 'receipt_invalid', 'another epoch');
  assert.equal(await code(finishWith(w, 'move-0001', { receipt: r, homeId: IDS.C.homeId })), 'receipt_invalid', 'another machine');
  assert.equal(await code(finishWith(w, 'move-0009', { receipt: r })), 'move_unknown', 'another move');
  assert.equal(await code(finishWith(w, 'move-0001', { receipt: `${r.slice(0, -4)}AAAA` })), 'receipt_invalid', 'a changed receipt');
  assert.equal(await code(finishWith(w, 'move-0001', { receipt: '' })), 'receipt_invalid', 'none');
  assert.ok(w.m.A!.hasData() && w.m.A!.hasKey(), 'nothing was deleted by any of them');
  assert.equal(await code(finishWith(w, 'move-0001', { receipt: r })), 'ok', 'the real one');
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  w.dispose();
});

test("a receipt from an older move, or from another world's move with the same id, is refused by a later move of the same old home", async () => {
  const other = await twoMachines();
  const { switched: foreign } = await upTo(other, 'B', 'move-0001', true);
  const w = await twoMachines();
  await upTo(w, 'B', 'move-0001'); // same move id, same epoch, same machines: only the target's signing key differs
  assert.equal(await code(finishWith(w, 'move-0001', { receipt: foreign.receipt })), 'receipt_invalid');
  assert.equal(w.m.A!.record().state, 'moving');
  assert.ok(w.m.A!.hasData() && w.m.A!.hasKey());
  other.dispose();
  w.dispose();
});

test('the receipt of an earlier move cannot finish a later one after MoMo came back to the same machine', async () => {
  const w = await twoMachines();
  const first = await upTo(w, 'B', 'move-0001', true);
  assert.equal(await code(finishWith(w, 'move-0001', { receipt: first.switched.receipt })), 'ok');
  // MoMo moves back: B pauses and seals to A, whose epoch-3 receipt is the only valid one
  const offer = await step(w, 'A', 'offer', { moveId: 'move-0002' });
  await step(w, 'B', 'begin', { moveId: 'move-0002' });
  await step(w, 'B', 'seal', { moveId: 'move-0002', targetKey: offer.targetKey, signKey: offer.signKey });
  const replay = await code(
    step(w, 'B', 'finish', { moveId: 'move-0002', leaseEpoch: 3, name: IDS.A.name, homeId: IDS.A.homeId, receipt: first.switched.receipt }),
  );
  assert.equal(replay, 'receipt_invalid');
  assert.equal(w.m.B!.record().state, 'moving');
  assert.ok(w.m.B!.hasData());
  w.dispose();
});

test('a discard proof of another move cannot resume a sealed old home, and the real one can', async () => {
  const w = await twoMachines();
  await upTo(w, 'B', 'move-0001');
  const stale = await step(w, 'B', 'discard', { moveId: 'move-0001' }); // the real proof for move-0001, kept for later
  assert.ok(stale.proof);
  // a second move cannot start while the first is open; settle it, then try a new one
  await step(w, 'A', 'cancel', { moveId: 'move-0001', proof: stale.proof });
  assert.equal(w.m.A!.acts(), true);
  await upTo(w, 'B', 'move-0002');
  assert.equal(
    await code(step(w, 'A', 'cancel', { moveId: 'move-0002', proof: stale.proof })),
    'move_not_given_up',
    'a proof for move-0001',
  );
  assert.equal(await code(step(w, 'A', 'cancel', { moveId: 'move-0002' })), 'move_not_given_up', 'no proof');
  assert.equal(w.m.A!.acts(), false);
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  w.dispose();
});

test("a sealed move never resumes on a clock: past its deadline the old home stays paused and says so, and settles on the target's receipt", async () => {
  const w = await twoMachines();
  const { switched } = await upTo(w, 'B', 'move-0001', true);
  w.tick(DEADLINE * 3);
  await w.m.A!.home.move.expire();
  assert.equal(w.m.A!.record().state, 'moving');
  assert.equal(w.m.A!.home.status().home.moveExpired, true);
  assert.equal(w.m.A!.acts(), false);
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  assert.equal(await code(finishWith(w, 'move-0001', { receipt: switched.receipt })), 'ok');
  assert.equal(w.m.A!.record().state, 'none');
  w.dispose();
});

test('an unsealed move ends by itself after the deadline, the move id stays closed, and a late seal or switch for it is refused', async () => {
  const w = await twoMachines();
  const offer = await step(w, 'B', 'offer', { moveId: 'move-0001' });
  await step(w, 'A', 'begin', { moveId: 'move-0001' });
  w.tick(DEADLINE + 1000);
  await w.m.A!.home.move.expire();
  assert.equal(w.m.A!.acts(), true, 'nothing left the machine, so it resumes');
  assert.equal(
    await code(step(w, 'A', 'seal', { moveId: 'move-0001', targetKey: offer.targetKey, signKey: offer.signKey })),
    'move_unknown',
  );
  assert.equal(await code(step(w, 'A', 'begin', { moveId: 'move-0001' })), 'move_closed');
  assert.equal(
    await code(step(w, 'B', 'commit', { moveId: 'move-0001', leaseEpoch: 2, homeId: IDS.B.homeId, name: IDS.B.name, from: IDS.A.name })),
    'move_expired',
  );
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  w.dispose();
});

test('clocks that disagree past the deadline: whichever side runs late, the target refuses an expired offer, the sealed old home waits, and there is never a second home', async () => {
  for (const skewB of [-DEADLINE, -MOVE_TTL_MS / 2, MOVE_TTL_MS / 2, DEADLINE]) {
    const w = await twoMachines({ skewB });
    await upTo(w, 'B', 'move-0001');
    w.tick(MOVE_TTL_MS + 1000); // A's clock is inside its deadline; B's may be outside its own
    const c = await code(
      step(w, 'B', 'commit', { moveId: 'move-0001', leaseEpoch: 2, homeId: IDS.B.homeId, name: IDS.B.name, from: IDS.A.name }),
    );
    assert.ok(['ok', 'move_expired'].includes(c), `skew ${skewB}: ${c}`);
    w.tick(DEADLINE);
    await w.m.A!.home.move.expire();
    assert.equal(w.m.A!.acts(), false, `skew ${skewB}: the sealed old home never resumes on its clock`);
    assert.deepEqual(await violations(w, sealedHashes(w)), [], `skew ${skewB}`);
    // the app settles it on the target's word, either way, and ends with one home
    const done = await recoverMove({ moveId: 'move-0001', from: w.net.side('A'), to: w.net.side('B'), target: IDS.B, ownerAccepts: true });
    assert.notEqual(done.state, 'uncertain', `skew ${skewB}`);
    assert.deepEqual(await violations(w, sealedHashes(w)), [], `skew ${skewB} settled`);
    assert.equal(w.all().filter((m) => m.acts()).length, 1, `skew ${skewB}: one home after settling`);
    w.dispose();
  }
});

test("a target that lost the offer (restarted) cannot sign: the old home resumes only on the owner's own decision, at a lease the target cannot hold", async () => {
  const w = await twoMachines();
  await upTo(w, 'B', 'move-0001');
  w.m.B!.kill();
  w.m.B!.restart();
  const before = (await w.net.side('A').call('begin', { moveId: 'move-0001' })).home.leaseEpoch;
  const asked = await recoverMove({ moveId: 'move-0001', from: w.net.side('A'), to: w.net.side('B'), target: IDS.B });
  assert.equal(asked.state, 'uncertain', 'without the owner, nothing resumes on an unsigned word');
  assert.equal(w.m.A!.acts(), false);
  const owner = await recoverMove({ moveId: 'move-0001', from: w.net.side('A'), to: w.net.side('B'), target: IDS.B, ownerAccepts: true });
  assert.equal(owner.state, 'resumed');
  assert.equal(w.m.A!.acts(), true);
  assert.equal(
    (await w.net.side('A').call('begin', { moveId: 'move-0009' })).home.leaseEpoch,
    before + 2,
    'at epoch + 2: the target holds at most epoch + 1',
  );
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  w.dispose();
});

test('a target that gave the move up refuses a late bundle and a late switch for good, and a drive of the same id after that is closed', async () => {
  const w = await twoMachines();
  const { sealed } = await upTo(w, 'B', 'move-0001');
  const gone = await step(w, 'B', 'discard', { moveId: 'move-0001' });
  assert.equal(
    await code(step(w, 'B', 'receive', { moveId: 'move-0001', sealed: sealed.sealed, bundleHash: sealed.bundleHash })),
    'move_discarded',
  );
  assert.equal(
    await code(step(w, 'B', 'commit', { moveId: 'move-0001', leaseEpoch: 2, homeId: IDS.B.homeId, name: IDS.B.name, from: IDS.A.name })),
    'move_discarded',
  );
  await step(w, 'A', 'cancel', { moveId: 'move-0001', proof: gone.proof });
  const again = await drive(w, { moveId: 'move-0001' });
  assert.equal(again.ok, false);
  assert.equal(w.m.B!.acts(), false);
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  w.dispose();
});
