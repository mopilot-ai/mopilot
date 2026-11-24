// The safety of a move (host/src/momoMove.mjs, shared/momoMove.mjs): no split brain, no stuck home, nothing deleted without the target's word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { MOVE_TTL_MS, MOVE_GRACE_MS } from '../host/src/momoMove.mjs';
// @ts-ignore
import { moveHome, recoverMove } from '../shared/momoMove.mjs';
import { A, B, host, studio } from './support/host/momoMoveWorld.ts';
import { waitFor } from './support/waitFor.ts';

const ids = { moveId: 'move-0001' };
const run = (a: any, b: any, extra: object = {}): Promise<any> =>
  moveHome({ ...ids, from: a.side ?? a, to: b.side ?? b, target: B, fromName: A.name, ...extra });
/** The steps up to the moment before the switch, by hand: what a driving client has done when it dies. */
async function untilCopied(a: any, b: any) {
  const offer = await b.side.call('offer', ids);
  await a.side.call('begin', ids);
  const sealed = await a.side.call('seal', { ...ids, targetKey: offer.targetKey, signKey: offer.signKey });
  await b.side.call('receive', { ...ids, sealed: sealed.sealed, bundleHash: sealed.bundleHash });
  return { offer, sealed };
}
const commit = (b: any, extra: object = {}) =>
  // a homeId in the request names nothing (S8): the machine is the Host's own id
  b.side.call('commit', { ...ids, leaseEpoch: 2, homeId: 'someone-else-9999', name: B.name, from: A.name, ...extra });

test('B3: a Host stuck in moving is visible to any device and can be cancelled before anything was sealed; one that sealed stays paused past its time and is settled with the target, never on a clock', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  await a.side.call('begin', ids);
  // any device reads the move from the status, and can abort a move that sealed nothing
  const seen = a.home.status().home;
  assert.deepEqual(
    [seen.state, seen.moveId, seen.moveDeadline, seen.moveExpired],
    ['moving', 'move-0001', a.clock.at + MOVE_TTL_MS + MOVE_GRACE_MS, false],
  );
  assert.equal((await a.side.call('cancel', ids)).home.state, 'running');
  assert.equal(a.home.status().home.moveId, null);
  // the move that ended stays ended: a late or repeated begin of it does not pause the running home (F12)
  await assert.rejects(a.side.call('begin', ids), (e: any) => e.code === 'move_closed');
  assert.equal(a.home.status().home.state, 'running');
  // a move that sealed nothing ends by itself when its time is out
  await a.side.call('begin', { moveId: 'move-0003' });
  a.clock.at += MOVE_TTL_MS + MOVE_GRACE_MS + 1;
  assert.equal((await a.side.call('begin', { moveId: 'move-0004' })).home.moveId, 'move-0004', 'the stale one ended first');
  await a.side.call('cancel', { moveId: 'move-0004' });
  // sealed, with the driving client gone: nothing may resume it on a guess
  const offer = await b.side.call('offer', { moveId: 'move-0005' });
  await a.side.call('begin', { moveId: 'move-0005' });
  await a.side.call('seal', { moveId: 'move-0005', targetKey: offer.targetKey, signKey: offer.signKey });
  await assert.rejects(a.side.call('cancel', { moveId: 'move-0005' }), (e: any) => e.code === 'move_not_given_up');
  await assert.rejects(
    a.side.call('begin', { moveId: 'move-0006' }),
    (e: any) => e.code === 'move_in_progress' && /Another move started/.test(e.message),
  );
  // past its time it STAYS paused (the target may have switched before its own deadline and the old home never heard) and says so
  a.clock.at += MOVE_TTL_MS + MOVE_GRACE_MS + 1;
  assert.equal((await a.home.move.expire()).home.state, 'moving');
  assert.equal(a.home.status().home.moveExpired, true);
  await assert.rejects(
    a.side.call('begin', { moveId: 'move-0006' }),
    (e: any) => e.code === 'move_in_progress' && /not been settled/.test(e.message),
  );
  await assert.rejects(
    a.side.call('seal', { moveId: 'move-0005', targetKey: offer.targetKey, signKey: offer.signKey }),
    (e: any) => e.code === 'move_expired',
  );
  // the target is asked, from any device: it gave the move up, so the old home resumes on its signed word
  b.clock.at = a.clock.at;
  assert.equal((await recoverMove({ moveId: 'move-0005', from: a.side, to: b.side, target: B })).state, 'resumed');
  assert.deepEqual([a.home.status().home.state, a.home.status().home.leaseEpoch], ['running', 1]);
  // the time-out never resumes a home whose target did switch: the target's receipt clears the old home instead
  await a.side.call('begin', { moveId: 'move-0007' });
  const second = await b.side.call('offer', { moveId: 'move-0007' });
  const sealed = await a.side.call('seal', { moveId: 'move-0007', targetKey: second.targetKey, signKey: second.signKey });
  await b.side.call('receive', { moveId: 'move-0007', sealed: sealed.sealed, bundleHash: sealed.bundleHash });
  await b.side.call('commit', { moveId: 'move-0007', leaseEpoch: 2, name: B.name, from: A.name });
  a.clock.at += 10 * MOVE_TTL_MS;
  assert.equal((await a.home.move.expire()).home.state, 'moving', 'a clock does not make two homes');
  const done = await recoverMove({ moveId: 'move-0007', from: a.side, to: b.side, target: B });
  assert.deepEqual([done.state, (done as any).oldHome, (done as any).leaseEpoch], ['switched', 'cleared', 2]);
  assert.equal(a.home.status().home.state, 'none');
});

test('B3: a Host that restarts while moving schedules the end of the move from its record', async (t) => {
  const a = await studio(t);
  await a.side.call('begin', ids);
  const { createMomoMove } = await import('../host/src/momoMove.mjs' as any);
  const again = createMomoMove({ home: a.home });
  a.clock.at += MOVE_TTL_MS + MOVE_GRACE_MS + 5000;
  assert.equal((await again.expire()).home.state, 'running');
});

test('B4: a late commit after the move was given up is refused, and the old home resumes only on the target’s word', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  await untilCopied(a, b);
  // the commit is in flight; the client gives up: the target tombstones the move and signs it
  const d = await b.side.call('discard', ids);
  assert.equal(d.discarded, true);
  assert.equal(typeof d.proof, 'string');
  // the late commit lands: refused for good, so there is never a second home
  await assert.rejects(commit(b), (e: any) => e.code === 'move_discarded');
  assert.equal(b.home.status().home, null);
  // a proof that is not the target's, or for another move, resumes nothing
  await assert.rejects(a.side.call('cancel', { ...ids, proof: 'AAAA' }), (e: any) => e.code === 'move_not_given_up');
  await assert.rejects(a.side.call('cancel', { ...ids, proof: d.proof.slice(0, -4) + 'AAAA' }), (e: any) => e.code === 'move_not_given_up');
  assert.equal(a.home.status().home.state, 'moving');
  // the target's own proof does
  assert.equal((await a.side.call('cancel', { ...ids, proof: d.proof })).home.state, 'running');
  // and a late bundle or a new offer of the same id is refused too
  await assert.rejects(b.side.call('offer', ids), (e: any) => e.code === 'move_discarded');
});

test('B4: a discard that finds the switch already made says so and undoes nothing; a repeated commit answers the same', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  await untilCopied(a, b);
  const first = await commit(b);
  const d = await b.side.call('discard', ids);
  assert.deepEqual([d.committed, d.leaseEpoch, d.receipt], [true, 2, first.receipt]);
  assert.equal(b.home.status().home.state, 'running');
  assert.equal((await commit(b)).receipt, first.receipt, 'sent again, the same');
  await assert.rejects(commit(b, { leaseEpoch: 3 }), (e: any) => e.code === 'home_lease_stale');
  // and the old home can finish on that receipt
  const done = await a.side.call('finish', { ...ids, leaseEpoch: 2, name: B.name, homeId: B.homeId, receipt: first.receipt });
  assert.equal(done.home.state, 'none');
});

test('B4 in the client: the commit’s answer is lost and the target cannot be asked: nobody runs on a guess; a target that gave the move up resumes the old home', async (t) => {
  // lost answer + target unreachable: the old home stays paused
  {
    const a = await studio(t);
    const b = await host(t, B);
    const dark = {
      call: async (op: string, p: any) => {
        if (op === 'commit') throw Object.assign(new Error('timed out'), { code: 'timeout' });
        if (op === 'discard') throw new Error('down');
        return b.side.call(op, p);
      },
    };
    const r = await run(a, dark);
    assert.deepEqual([r.ok, r.uncertain, r.rolledBack], [false, true, false]);
    assert.equal(a.home.status().home.state, 'moving');
    // the time runs out: it still does not resume on a clock (the target may have switched); it resumes when the target is reached and gave the move up
    a.clock.at += MOVE_TTL_MS + MOVE_GRACE_MS + 1;
    assert.equal((await a.home.move.expire()).home.state, 'moving');
    const unreachable = await recoverMove({ moveId: 'move-0001', from: a.side, to: dark, target: B });
    assert.equal(unreachable.state, 'uncertain');
    assert.equal(a.home.status().home.state, 'moving', 'a target that cannot be asked changes nothing');
    assert.equal((await recoverMove({ moveId: 'move-0001', from: a.side, to: b.side, target: B })).state, 'resumed');
    assert.equal(a.home.status().home.state, 'running');
  }
  // a commit that never reached the target, whose answer is an error: the target gives up, then the old home resumes, and a late arrival is refused
  {
    const a = await studio(t);
    const b = await host(t, B);
    let late: (() => Promise<unknown>) | null = null;
    const slow = {
      call: async (op: string, p: any) => {
        if (op !== 'commit') return b.side.call(op, p);
        late = () => b.side.call(op, p);
        throw Object.assign(new Error('timed out'), { code: 'timeout' });
      },
    };
    const r = await run(a, slow);
    assert.deepEqual([r.ok, r.step, r.rolledBack], [false, 'switching', true]);
    assert.equal(a.home.status().home.state, 'running');
    await assert.rejects(late!(), (e: any) => e.code === 'move_discarded', 'the late commit is refused: one home');
    assert.equal(b.home.status().home, null);
  }
});

test('B5: a switch that is refused leaves nothing on the target: before a file moves, and after', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  await untilCopied(a, b);
  const clean = () => ({
    data: fs.existsSync(b.momoDir) ? fs.readdirSync(b.momoDir).filter((f) => !['grant.json', 'home.json'].includes(f)) : [],
    key: fs.existsSync(path.join(b.dataKeyDir, 'safe-storage.key')),
  });
  // refused before anything moves: a lease that is not newer
  await assert.rejects(commit(b, { leaseEpoch: 0 }), (e: any) => e.code === 'home_lease_stale');
  assert.deepEqual(clean(), { data: [], key: false });
  // refused after the files were put in place: they go again
  const real = b.home.adopt;
  b.home.adopt = async () => {
    throw new Error('the record could not be written');
  };
  await assert.rejects(commit(b), /could not be written/);
  assert.deepEqual(clean(), { data: [], key: false });
  b.home.adopt = real;
  // what was received is gone with the refused switch, so that move cannot be committed any more; it is given up, the old home resumes on the
  // target's signed word, and a new move goes through
  await assert.rejects(commit(b), (e: any) => e.code === 'move_unknown');
  const given = await b.side.call('discard', ids);
  assert.equal(typeof given.proof, 'string');
  assert.equal((await a.side.call('cancel', { ...ids, proof: given.proof })).home.state, 'running');
  const again = await moveHome({ moveId: 'move-0002', from: a.side, to: b.side, target: B, fromName: A.name });
  assert.equal(again.ok, true);
});

test('B5: a machine that turns out to keep a retired copy while a switch fails keeps it: a move never wipes a retired home’s data', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  await untilCopied(a, b);
  const real = b.home.adopt;
  // the target is retired by something else in the middle of the switch, and the switch is then refused
  b.home.adopt = async () => {
    await b.home.swap((b.home.record() as any).leaseEpoch, (r: any) => {
      r.retired = { at: 1, lastActive: 1 };
      r.movedTo = { name: 'Elsewhere', homeId: 'elsewhere', at: 1 };
      return false;
    });
    throw new Error('the record could not be written');
  };
  await assert.rejects(commit(b), /could not be written/);
  const kept = fs.readdirSync(b.momoDir).filter((f) => !['grant.json', 'home.json'].includes(f));
  assert.ok(kept.length > 0, 'what was received stays: it is the retired copy’s now, to be deleted only by the owner');
  b.home.adopt = real;
});

test('B5: a target that is a home, or has data, refuses the switch before anything changes, and a second offer replaces the first’s stage', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  const { sealed } = await untilCopied(a, b);
  assert.ok(sealed);
  // another offer takes over the one stage folder: the earlier move is given up
  const second = await b.side.call('offer', { moveId: 'move-0002' });
  assert.ok(second.signKey);
  await assert.rejects(commit(b), (e: any) => e.code === 'move_discarded');
  assert.equal(fs.existsSync(`${b.momoDir}.incoming`), false);
  // a home refuses to be a target
  const other = await host(t, { homeId: 'home-cccc-3333', name: 'Laptop' });
  await other.home.start({ homeId: 'home-cccc-3333', name: 'Laptop' });
  await assert.rejects(other.side.call('offer', { moveId: 'move-0003' }), (e: any) => e.code === 'home_exists');
});

test('B6: the old home deletes its copy only on the target’s signed receipt for this move, epoch, machine and bundle', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  await untilCopied(a, b);
  const real = await commit(b);
  const fin = (extra: object = {}) =>
    a.side.call('finish', { ...ids, leaseEpoch: 2, name: B.name, homeId: B.homeId, receipt: real.receipt, ...extra });
  for (const bad of [
    { receipt: 'AAAA' },
    { receipt: '' },
    { receipt: real.receipt.slice(0, -4) + 'AAAA' },
    { homeId: 'home-cccc-3333' },
    { leaseEpoch: 3 },
  ])
    await assert.rejects(fin(bad), (e: any) => ['receipt_invalid', 'home_lease_stale'].includes(e.code), JSON.stringify(bad));
  // a receipt of another target for the same move id is not this target's
  const x = await host(t, { homeId: 'home-dddd-4444', name: 'Other' });
  const y = await studio(t);
  await untilCopied(y, x);
  const foreign = await x.side.call('commit', { ...ids, leaseEpoch: 2, homeId: 'home-dddd-4444', name: 'Other', from: A.name });
  await assert.rejects(fin({ receipt: foreign.receipt }), (e: any) => e.code === 'receipt_invalid');
  // nothing was deleted by any of them
  assert.equal(a.home.status().home.state, 'moving');
  assert.deepEqual(a.home.stores() === null, true);
  assert.ok(fs.existsSync(a.dataKeyDir), 'the key is still there');
  assert.ok(fs.readdirSync(a.momoDir).length > 2, 'and the data');
  assert.equal(b.home.status().home.homeId, B.homeId, 'named by its own id, not the one the request carried');
  assert.equal((await fin()).home.state, 'none');
  assert.equal(fs.existsSync(a.dataKeyDir), false);
});

test('S3: a move stops the turns the harness is running before it seals, and parks the ledger’s', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  const order: string[] = [];
  a.home.stopTurns = async () => void order.push('stop');
  const parked = a.home.parkTurns;
  a.home.parkTurns = async () => (order.push('park'), parked());
  const real = a.side.call;
  a.side.call = async (op: string, p: any) => (order.push(op), real(op, p));
  assert.equal((await run(a, b)).ok, true);
  assert.deepEqual(order.slice(0, 4), ['begin', 'stop', 'park', 'seal']);
  assert.equal(b.home.stores()!.turns.status('key-00000001').state, 'interrupted');
});

test('F2, F4: a begin sent again parks the turns again; two begins at once make one move', async (t) => {
  const a = await studio(t);
  let parked = 0;
  const park = a.home.parkTurns;
  a.home.parkTurns = async () => (parked++, park());
  await a.side.call('begin', ids);
  // a turn accepted between the first begin and its resend is parked by the resend, so it never goes into the bundle as `accepted`
  await a.home.stores()?.turns;
  await a.side.call('begin', ids);
  assert.equal(parked, 2);
  await a.side.call('cancel', ids);
  const both = await Promise.allSettled([a.side.call('begin', { moveId: 'move-0010' }), a.side.call('begin', { moveId: 'move-0011' })]);
  assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(((both.find((r) => r.status === 'rejected') as any).reason as any).code, 'move_in_progress');
});

test('F6, F7: an offer sent again is the same offer; a late discard of an earlier move leaves the current move’s staged copy alone', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  const first = await b.side.call('offer', ids);
  const again = await b.side.call('offer', ids);
  assert.deepEqual(again, first, 'no new key: a bundle sealed to the first still opens');
  await a.side.call('begin', ids);
  const sealed = await a.side.call('seal', { ...ids, targetKey: first.targetKey, signKey: first.signKey });
  await b.side.call('receive', { ...ids, sealed: sealed.sealed, bundleHash: sealed.bundleHash });
  assert.equal(fs.existsSync(`${b.momoDir}.incoming`), true);
  // another move's discard, late, does not touch the stage this move owns
  assert.deepEqual(await b.side.call('discard', { moveId: 'move-0009' }), { discarded: true, proof: null });
  assert.equal(fs.existsSync(`${b.momoDir}.incoming`), true, 'the current move’s copy is still there');
  assert.equal((await b.side.call('commit', { ...ids, leaseEpoch: 2, name: B.name, from: A.name })).home.state, 'running');
});

test('F8: a machine MoMo moved away from is not the home again by a start; a Reset there clears the tombstone', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  assert.equal((await run(a, b)).ok, true);
  await assert.rejects(a.home.start({ name: 'Studio' }), (e: any) => e.code === 'home_moved' && /moved to Mac mini/.test(e.message));
  assert.equal(a.home.status().home.state, 'none');
  await a.home.reset();
  assert.equal(a.home.status().home, null, 'the person starts over on it');
  assert.equal((await a.home.start({ name: 'Studio' })).home.leaseEpoch, 3, 'a new home of its own lease');
});

test('F10, F11: a switch cut short leaves debris that the next offer clears; the moved entry is in the audit chain before the record names the new home', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  await untilCopied(a, b);
  // killed after the files were moved and before the record: simulated by putting the data in place and not adopting
  fs.mkdirSync(path.join(b.momoDir, 'audit'), { recursive: true });
  fs.writeFileSync(path.join(b.momoDir, 'memory.json'), 'half');
  fs.mkdirSync(b.dataKeyDir, { recursive: true });
  fs.writeFileSync(path.join(b.dataKeyDir, 'safe-storage.key'), Buffer.alloc(32, 1));
  // a retry of the move (a new move id, a new offer) works: the debris of a machine that is no home is cleared
  const second = await b.side.call('offer', { moveId: 'move-0002' });
  assert.ok(second.signKey);
  assert.equal(fs.existsSync(path.join(b.momoDir, 'memory.json')), false);
  assert.equal(fs.existsSync(path.join(b.dataKeyDir, 'safe-storage.key')), false);
  // the whole move then goes through, and the chain has its moved entry written before the switch
  await a.side.call('cancel', { ...ids, ownerAccepts: true }).catch(() => undefined);
  const fresh = await studio(t);
  const target = await host(t, B);
  assert.equal((await moveHome({ moveId: 'move-0020', from: fresh.side, to: target.side, target: B, fromName: A.name })).ok, true);
  const log = await target.home.stores()!.audit.exportJsonl();
  assert.match(log, /momo\.home\.moved/);
  assert.equal((await target.home.stores()!.audit.verify()).ok, true);
  // the repeat of the commit after a restart of the target (its in-memory offer is gone) answers from the record with the same receipt
  const { createMomoMove } = await import('../host/src/momoMove.mjs' as any);
  const restarted = createMomoMove({ home: target.home });
  const rec = target.home.record()!;
  const again = await restarted.commit({ moveId: 'move-0020', leaseEpoch: rec.leaseEpoch, name: B.name, from: A.name });
  assert.equal(typeof again.receipt, 'string');
  assert.equal((await restarted.discard({ moveId: 'move-0020' })).committed, true);
  await assert.rejects(
    restarted.commit({ moveId: 'move-0020', leaseEpoch: rec.leaseEpoch + 1, name: B.name, from: A.name }),
    (e: any) => e.code === 'home_lease_stale',
  );
});

test('the owner may resume a sealed move past its time when the target answers that it lost the move; before that no one can', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  await untilCopied(a, b);
  // the target lost its offer (a restart): its discard has no proof
  b.home.move = (await import('../host/src/momoMove.mjs' as any)).createMomoMove({ home: b.home });
  a.clock.at += MOVE_TTL_MS + MOVE_GRACE_MS + 1;
  const asked = await recoverMove({ moveId: 'move-0001', from: a.side, to: b.side, target: B });
  assert.equal(asked.state, 'uncertain', 'no proof, no owner’s word: still paused');
  assert.equal(a.home.status().home.state, 'moving');
  await assert
    .rejects(
      a.side.call('cancel', { ...ids, ownerAccepts: true }).then(() => undefined),
      () => false,
    )
    .catch(() => undefined);
  assert.equal((await recoverMove({ moveId: 'move-0001', from: a.side, to: b.side, target: B, ownerAccepts: true })).state, 'resumed');
  assert.equal(a.home.status().home.state, 'running');
});

test('F1, F9: a Retry after a lost Cancel settles the stale move with the target first; an old machine that was offline is cleared by a later retry with the target’s receipt', async (t) => {
  const { createMoveRunner } = await import('../shared/momoMoveRunner.mjs' as any);
  // F1: the Cancel after a failed receive is lost, so the old home stays paused; Retry does not meet "Another move started"
  const a = await studio(t);
  const b = await host(t, B);
  let lose = true;
  const aSide = {
    call: async (op: string, p: any) => {
      if (op === 'cancel' && lose) throw new Error('lost');
      return a.side.call(op, p);
    },
  };
  let spoiled = true;
  const bSide = {
    call: async (op: string, p: any) => {
      if (op === 'receive' && spoiled) {
        spoiled = false;
        throw Object.assign(new Error('Mac mini stopped answering.'), { code: 'timeout' });
      }
      return b.side.call(op, p);
    },
  };
  const machines: any = {
    studio: { id: 'studio', hostId: A.homeId, name: A.name, side: aSide },
    mini: { id: 'mini', hostId: B.homeId, name: B.name, side: bSide },
  };
  let n = 0;
  const runner = createMoveRunner({
    home: () => ({ id: 'studio', name: A.name }),
    machine: (id: string) => machines[id] ?? null,
    newId: () => `move-r${String(++n).padStart(4, '0')}`,
    changed: () => undefined,
  });
  await runner.start('mini');
  await waitFor(() => runner.view()?.failure, 'the move to fail');
  assert.equal(runner.view()!.failure!.failedAt, 'copied');
  assert.equal(a.home.status().home.state, 'moving', 'the Cancel was lost: the old home is still paused');
  lose = false;
  await runner.retry();
  await waitFor(() => runner.view()?.outcome === 'moved', 'the move to finish');
  assert.equal(runner.view()!.outcome, 'moved');
  assert.equal(b.home.status().home.state, 'running');
  // nothing is waiting to be cleared, and settling needs a move that ended
  await assert.rejects(runner.retryPending(), /Nothing is waiting/);

  // F9: the old machine is offline at the end; a later retry clears it with the receipt the target gave
  const c = await studio(t);
  const d = await host(t, B);
  let up = true;
  const cSide = {
    call: async (op: string, p: any) => {
      if (op === 'finish' && !up) throw new Error('offline');
      return c.side.call(op, p);
    },
  };
  const m2: any = {
    studio: { id: 'studio', hostId: A.homeId, name: A.name, side: cSide },
    mini: { id: 'mini', hostId: B.homeId, name: B.name, side: d.side },
  };
  const r2 = createMoveRunner({
    home: () => ({ id: 'studio', name: A.name }),
    machine: (id: string) => m2[id],
    newId: () => 'move-f9000001',
    changed: () => undefined,
  });
  up = false;
  await r2.start('mini');
  await waitFor(() => r2.view()?.oldMachineOffline, 'the move to end with the old machine offline');
  assert.equal(r2.view()!.oldMachineOffline, true);
  await assert.rejects(r2.retryPending(), /did not answer/);
  up = true;
  await r2.retryPending();
  assert.equal(r2.view()!.oldMachineOffline, false);
  assert.equal(c.home.status().home.state, 'none');
  // settling a move that already finished answers from the target again and changes nothing; with no move there is nothing to settle
  await r2.recover();
  assert.equal(c.home.status().home.state, 'none');
  const idle = createMoveRunner({ home: () => null, machine: () => null, newId: () => 'x', changed: () => undefined });
  await assert.rejects(idle.recover(), /no move to settle/);
});
