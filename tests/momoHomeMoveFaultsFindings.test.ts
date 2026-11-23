// The twelve faults found in the first round of this harness (F1-F12) and the two of the second (F2 after a restart, F13), now guards of the fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './support/waitFor.ts';
// @ts-ignore: plain ESM without declarations
import { createMoveRunner } from '../shared/momoMoveRunner.mjs';
import { twoMachines, drive, violations, sealedHashes, recover, IDS, OPEN_TURN, type World } from './momoEvals/home/world.ts';

const step = (w: World, key: 'A' | 'B' | 'C', op: string, p: object) => w.net.side(key).call(op, p);
/** Wait for a runner's move to end (it runs on in the background). */
async function ended(runner: any) {
  return waitFor(() => runner.result(), 'the move to end');
}
const runnerOver = (w: World) => {
  let n = 0;
  return createMoveRunner({
    home: () => ({ id: IDS.A.homeId, name: IDS.A.name }),
    machine: (id: string) =>
      id === IDS.A.homeId ? { id, name: IDS.A.name, side: w.net.side('A') } : { id, name: IDS.B.name, side: w.net.side('B') },
    newId: () => `move-${String(++n).padStart(4, '0')}`,
    changed: () => undefined,
  });
};
/** Run a move to the point just before the switch: offered, paused, sealed, received. */
async function toReceived(w: World, moveId = 'move-0001', to: 'B' | 'C' = 'B') {
  const offer = await step(w, to, 'offer', { moveId });
  await step(w, 'A', 'begin', { moveId });
  const sealed = await step(w, 'A', 'seal', { moveId, targetKey: offer.targetKey, signKey: offer.signKey });
  await step(w, to, 'receive', { moveId, sealed: sealed.sealed, bundleHash: sealed.bundleHash });
  return { offer, sealed };
}

test('F1 fixed: after a move whose Cancel was lost, Retry settles the stale move with the target first and goes through', async () => {
  const w = await twoMachines();
  w.net.faults = [{ machine: 'A', op: 'seal', kind: 'kill-before' }];
  const runner = runnerOver(w);
  await runner.start(IDS.B.homeId);
  assert.equal((await ended(runner)).rolledBack, false);
  w.m.A!.restart();
  w.net.faults = [];
  await runner.retry();
  const second = await ended(runner);
  assert.equal(second.ok, true, `${second.code}: ${second.message}`);
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  w.dispose();
});

test('F2 fixed: a begin sent again after the old home restarted during its pause parks the turn in flight', async () => {
  const w = await twoMachines();
  w.net.faults = [{ machine: 'A', op: 'begin', kind: 'kill-at', k: 2 }]; // after home.json says moving, before turns.json is parked
  await step(w, 'A', 'begin', { moveId: 'move-0001' }).catch(() => undefined);
  w.m.A!.restart();
  await step(w, 'A', 'begin', { moveId: 'move-0001' });
  assert.notEqual(w.m.A!.turnState(OPEN_TURN), 'accepted', 'begin answered, so the turns in flight are parked');
  w.dispose();
});

test('F3 fixed: finish without the target having committed deletes nothing', async () => {
  const w = await twoMachines();
  await toReceived(w);
  await assert.rejects(
    step(w, 'A', 'finish', { moveId: 'move-0001', leaseEpoch: 2, name: IDS.B.name, homeId: IDS.B.homeId, receipt: 'AAAA' }),
    (e: any) => e.code === 'receipt_invalid',
  );
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  w.dispose();
});

test('F4 fixed: two begins at once with different move ids: one wins', async () => {
  const w = await twoMachines();
  const r = await Promise.allSettled([step(w, 'A', 'begin', { moveId: 'move-0001' }), step(w, 'A', 'begin', { moveId: 'move-0002' })]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  w.dispose();
});

test('F5 fixed: a commit that arrives after the old home cancelled is refused, so there is one home', async () => {
  const w = await twoMachines();
  w.net.faults = [
    { machine: 'B', op: 'commit', kind: 'delay' },
    { machine: 'A', op: 'cancel', kind: 'flush' },
  ];
  const r = await drive(w);
  assert.equal(r.ok, false);
  await w.net.deliverHeld();
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  assert.equal(w.m.B!.acts(), false);
  w.dispose();
});

test('F6 fixed: an offer sent twice is the same offer', async () => {
  const w = await twoMachines();
  const one = await step(w, 'B', 'offer', { moveId: 'move-0001' });
  const two = await step(w, 'B', 'offer', { moveId: 'move-0001' });
  assert.deepEqual([two.targetKey, two.signKey], [one.targetKey, one.signKey]);
  w.dispose();
});

test('F7 fixed: a late discard of an earlier move leaves the copy the current move received', async () => {
  const w = await twoMachines();
  await step(w, 'B', 'offer', { moveId: 'move-0001' });
  await toReceived(w, 'move-0002'); // a second move takes the stage over from the first
  await step(w, 'B', 'discard', { moveId: 'move-0001' }); // the earlier attempt's frame arrives late
  // the second offer on B replaced the first (told to give up); if the second move got as far as receive, commit still works
  const commit = await step(w, 'B', 'commit', {
    moveId: 'move-0002',
    leaseEpoch: 2,
    homeId: IDS.B.homeId,
    name: IDS.B.name,
    from: IDS.A.name,
  }).then(
    () => 'ok',
    (e: any) => String(e.code),
  );
  assert.equal(commit, 'ok');
  w.dispose();
});

test('F8 fixed: a machine MoMo moved away from does not start as the home again beside the new home', async () => {
  const w = await twoMachines();
  assert.equal((await drive(w)).ok, true);
  await assert.rejects(w.m.A!.home.start(IDS.A), (e: any) => e.code === 'home_moved');
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  w.dispose();
});

test('F9 fixed: the old home offline at the end is cleared later with the target receipt (retryPending)', async () => {
  const w = await twoMachines();
  w.net.faults = [{ machine: 'A', op: 'finish', kind: 'drop-req' }];
  const runner = runnerOver(w);
  await runner.start(IDS.B.homeId);
  assert.equal((await ended(runner)).oldHome, 'offline');
  await runner.retryPending();
  assert.equal(w.m.A!.record().state, 'none');
  assert.equal(w.m.A!.hasKey() || w.m.A!.hasData(), false);
  w.dispose();
});

test('F10 fixed: a target killed during the switch is cleared by the next offer, and the move can be tried again', async () => {
  const w = await twoMachines();
  w.net.faults = [{ machine: 'B', op: 'commit', kind: 'kill-at', k: 3 }];
  await drive(w);
  await recover(w, ['move-0001']);
  const again = await drive(w, { moveId: 'move-0002' });
  assert.equal(again.ok, true, `${again.code}: ${again.message}`);
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  w.dispose();
});

test('F11 fixed: wherever the target is killed during the switch, a target that runs afterwards has the moved entry', async () => {
  let ran = 0;
  for (let k = 1; k <= 30; k++) {
    const w = await twoMachines();
    w.net.faults = [{ machine: 'B', op: 'commit', kind: 'kill-at', k }];
    await drive(w);
    w.m.B!.restart();
    if (w.m.B!.record().state === 'running') {
      ran++;
      assert.equal(await w.m.B!.movedEntry(), true, `killed at state change ${k}`);
    }
    w.dispose();
  }
  assert.ok(ran >= 1, 'some kill points are after the switch');
});

test('F12 fixed: a begin frame of a cancelled move does not pause the home again (move_closed)', async () => {
  const w = await twoMachines();
  const r = await drive(w, { cancelled: () => true });
  assert.equal(r.code, 'cancelled');
  await assert.rejects(step(w, 'A', 'begin', { moveId: 'move-0001' }), (e: any) => e.code === 'move_closed');
  assert.equal(w.m.A!.acts(), true);
  w.dispose();
});

test('F13 fixed: after a begin whose answer was lost, Retry settles the stale move and goes through', async () => {
  const w = await twoMachines();
  w.net.faults = [{ machine: 'A', op: 'begin', kind: 'drop-resp' }];
  const runner = runnerOver(w);
  await runner.start(IDS.B.homeId);
  const first = await ended(runner);
  assert.equal(first.ok, false);
  w.net.faults = [];
  await runner.retry();
  const second = await ended(runner);
  assert.equal(second.ok, true, `${second.code}: ${second.message}`);
  w.dispose();
});
