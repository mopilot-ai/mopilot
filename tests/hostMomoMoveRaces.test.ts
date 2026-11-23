// The races of a move (host/src/momoMove.mjs): steps from two devices at once run one after another, exactly one of a receipt and a discard proof is signed for a move, the owner's reclaim fences the target out, and a receipt outlives later moves and restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createMomoMove } from '../host/src/momoMove.mjs';
// @ts-ignore
import { moveHome, reclaimHere, reclaimWords } from '../shared/momoMove.mjs';
import { A, B, host, studio } from './support/host/momoMoveWorld.ts';

const ids = { moveId: 'move-0001' };
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: any) => String(e.code),
  );
async function untilCopied(a: any, b: any, moveId = 'move-0001') {
  const offer = await b.side.call('offer', { moveId });
  await a.side.call('begin', { moveId });
  const sealed = await a.side.call('seal', { moveId, targetKey: offer.targetKey, signKey: offer.signKey });
  await b.side.call('receive', { moveId, sealed: sealed.sealed, bundleHash: sealed.bundleHash });
  return { offer, sealed };
}
const commit = (b: any, moveId = 'move-0001', leaseEpoch = 2) =>
  b.side.call('commit', { moveId, leaseEpoch, homeId: 'ignored-by-host', name: B.name, from: A.name });

test('two seals at once make one bundle, and a cancel that races a seal leaves one consistent end', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  const offer = await b.side.call('offer', ids);
  await a.side.call('begin', ids);
  const seal = () => a.side.call('seal', { ...ids, targetKey: offer.targetKey, signKey: offer.signKey });
  const [x, y] = await Promise.all([code(seal()), code(seal())]);
  assert.deepEqual([x, y].sort(), ['move_sealed', 'ok'], 'one wins, the other is told it was sealed');
  // a cancel at the same time as a seal: whichever runs first, the record ends in one of the two legal states
  const c = await studio(t);
  await c.side.call('begin', { moveId: 'move-0002' });
  const [s, k] = await Promise.all([
    code(c.side.call('seal', { moveId: 'move-0002', targetKey: offer.targetKey, signKey: offer.signKey })),
    code(c.side.call('cancel', { moveId: 'move-0002' })),
  ]);
  const rec = c.home.status().home;
  if (s === 'ok') assert.equal(rec.state, 'moving', 'sealed first: the cancel needs the target’s proof');
  else assert.equal(rec.state, 'running', 'cancelled first: nothing left, the seal found no move');
  assert.ok(k === 'ok' || k === 'move_not_given_up', k);
});

test('a discard that races a commit: exactly one of the receipt and the discard proof is signed, whichever came first', async (t) => {
  for (const discardFirst of [true, false]) {
    const a = await studio(t);
    const b = await host(t, B);
    await untilCopied(a, b);
    const calls = discardFirst ? [b.side.call('discard', ids), commit(b)] : [commit(b), b.side.call('discard', ids)];
    const [first, second] = await Promise.allSettled(calls);
    const results = discardFirst ? [first, second] : [second, first];
    const [d, c] = results as [PromiseFulfilledResult<any>, PromiseSettledResult<any>];
    if (discardFirst) {
      assert.equal(typeof d.value.proof, 'string', 'the discard won: it signed its proof');
      assert.equal(c.status, 'rejected');
      assert.equal((c as PromiseRejectedResult).reason.code, 'move_discarded');
      assert.equal(b.home.status().home?.state ?? 'none', 'none');
    } else {
      assert.equal(c.status, 'fulfilled');
      assert.equal(d.value.committed, true, 'the discard found the switch made and says so');
      assert.equal(d.value.proof, undefined, 'no proof is ever signed for a move that switched');
      assert.equal(typeof d.value.receipt, 'string');
      assert.equal(b.home.status().home.state, 'running');
    }
  }
});

test('the owner reclaims at epoch + 2, a late target at epoch + 1 is refused by every receiver, and the reclaim words say what happened', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  await untilCopied(a, b);
  const before = a.home.status().home.leaseEpoch;
  assert.deepEqual(reclaimWords(B.name, A.name), {
    title: 'Run MoMo on Studio again?',
    body: 'The copy on Mac mini will be refused if it ever comes back. Anything it did there since the move began is not kept.',
    confirm: 'Run on Studio',
  });
  const back = await a.side.call('reclaim', { ...ids, ownerConfirmed: true, target: 'lost' });
  assert.equal(back.home.state, 'running');
  assert.equal(back.home.leaseEpoch, before + 2);
  assert.equal(
    await code(a.side.call('reclaim', { ...ids, ownerConfirmed: true, target: 'lost' })),
    'move_unknown',
    'a reclaim is not repeated',
  );

  // the target had received the bundle and now switches late, at the lease it was offered
  await commit(b, ids.moveId, before + 1);
  const newer = { homeId: A.homeId, leaseEpoch: before + 2 };
  const older = { homeId: B.homeId, leaseEpoch: before + 1 };
  // a Host that has seen the owner's lease refuses the late target's stamps, in any order; one that saw the target's first learns the newer
  assert.equal((await a.home.receiveStamp(older)).ok, true, 'a receiver that has seen nothing takes it…');
  assert.equal((await a.home.receiveStamp(newer)).ok, true, '…and then the newer');
  const refused: any = await a.home.receiveStamp(older);
  assert.deepEqual([refused.ok, refused.reason], [false, 'stale']);
  const fresh = await host(t, { homeId: 'home-cccc-3333', name: 'Laptop' });
  assert.equal((await fresh.home.receiveStamp(newer)).ok, true);
  assert.equal(((await fresh.home.receiveStamp(older)) as any).ok, false);
  assert.equal(
    ((await fresh.home.receiveStamp({ homeId: 'someone-else-1', leaseEpoch: before + 2 })) as any).reason,
    'two-homes',
    'two claimants of one lease: neither is trusted',
  );
});

test('a receipt outlives later moves and a restart: a repeated commit answers the same, and the old home finishes on it', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  await untilCopied(a, b);
  const first = await commit(b);
  // a restart of the target's move object forgets its offers, not what the record keeps
  b.home.move = createMomoMove({ home: b.home });
  const again = await commit(b);
  assert.equal(again.receipt, first.receipt);
  assert.equal((await b.side.call('discard', ids)).receipt, first.receipt, 'a discard after the restart tells the switch, never undoes it');
  // MoMo moves on from B to a third machine and back history is longer: the first receipt is still told
  const c = await host(t, { homeId: 'home-cccc-3333', name: 'Laptop' });
  const hop = await moveHome({
    moveId: 'move-0002',
    from: b.side,
    to: c.side,
    target: { homeId: 'home-cccc-3333', name: 'Laptop' },
    fromName: B.name,
  });
  assert.equal(hop.ok, true);
  assert.equal((await b.side.call('discard', ids)).receipt, first.receipt);
  assert.equal(
    (await a.side.call('finish', { ...ids, leaseEpoch: 2, name: B.name, homeId: B.homeId, receipt: first.receipt })).home.state,
    'none',
  );
});

test('B5: a switch whose files cannot be put in place leaves no data, no key and no stage, and a later offer starts clean', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  await untilCopied(a, b);
  // the key folder cannot be made: a plain file sits where it must go
  fs.mkdirSync(path.dirname(b.dataKeyDir), { recursive: true });
  fs.rmSync(b.dataKeyDir, { recursive: true, force: true });
  fs.writeFileSync(b.dataKeyDir, 'not a folder');
  await assert.rejects(commit(b));
  assert.equal(fs.existsSync(path.join(b.momoDir, 'chats.json')), false);
  assert.deepEqual(fs.existsSync(b.momoDir) ? fs.readdirSync(b.momoDir).filter((f) => !['grant.json', 'home.json'].includes(f)) : [], []);
  assert.equal(b.home.status().home?.state ?? 'none', 'none', 'the record never named the new home');
});

test('the client finishes with the homeId the commit returned, not the one it believed the machine had', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  // the app's id for the machine is not the Host's own id: the receipt is for the Host's, and the old copy is still wiped
  const result = await moveHome({
    ...ids,
    from: a.side,
    to: b.side,
    target: { homeId: 'app-machine-id-9', name: B.name },
    fromName: A.name,
  });
  assert.equal(result.ok, true);
  assert.equal(a.home.status().home?.state ?? 'none', 'none');
  assert.equal(fs.existsSync(path.join(a.dataKeyDir, 'safe-storage.key')), false, 'the old copy’s key was deleted on the target’s receipt');
});

test('the ids of the turns a Reset deleted, and the turn ledger with its tombstones, move with MoMo: an old id never reads safe to send on the new home', async (t) => {
  const a = await studio(t);
  await a.home.stores().turns.settle('claude:c1', 'completed');
  await a.home.reset(); // the ledger is deleted, its ids are kept as void
  assert.equal(a.home.voided('key-00000001'), true);
  const s = a.home.stores();
  await s.turns.accept({ turnId: 'key-00000002', chatId: 'claude:c1', deviceId: 'phone', leaseEpoch: 1 });
  await s.turns.settle('claude:c1', 'failed');
  const b = await host(t, B);
  const moved = await moveHome({ ...ids, from: a.side, to: b.side, target: B, fromName: A.name });
  assert.equal(moved.ok, true);
  assert.equal(b.home.voided('key-00000001'), true, 'the void ids came in the bundle');
  assert.deepEqual(await b.home.turn('key-00000001'), { turnId: 'key-00000001', state: 'cancelled', void: true });
  assert.equal(((await b.home.turn('key-00000002')) as any).state, 'failed', 'and the ledger with the turns it kept');
});

test('finish writes the tombstone before it wipes: a cut-short finish never leaves a moving home with no data, and a repeat deletes what is left', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  await untilCopied(a, b);
  const { receipt } = await commit(b);
  const real = a.home.close;
  // the wipe fails after the tombstone: the old home is already no home
  a.home.close = async () => {
    throw new Error('the disk went away');
  };
  const fin = () => a.side.call('finish', { ...ids, leaseEpoch: 2, name: B.name, homeId: B.homeId, receipt });
  await assert.rejects(fin(), /disk went away/);
  assert.equal(a.home.status().home?.state ?? 'none', 'none', 'never moving with nothing to run');
  assert.equal(a.home.status().movedTo?.name ?? a.home.status().home?.movedTo?.name, B.name);
  a.home.close = real;
  await fin(); // sent again: the leftovers go
  assert.equal(fs.existsSync(path.join(a.dataKeyDir, 'safe-storage.key')), false);
});

test('reclaim refuses when the copy is gone, and when no paired device asks, and the wire carries an explicit owner decision', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  await untilCopied(a, b);
  const ask = { ...ids, ownerConfirmed: true, target: 'lost' };
  assert.equal(await code(a.home.move.reclaim({ ...ask })), 'reclaim_not_owner', 'no device named, no reclaim');
  fs.rmSync(a.dataKeyDir, { recursive: true, force: true });
  for (const f of fs.readdirSync(a.momoDir))
    if (!['grant.json', 'home.json', 'chats.json', 'stamps.json'].includes(f))
      fs.rmSync(path.join(a.momoDir, f), { recursive: true, force: true });
  assert.equal(await code(a.side.call('reclaim', ask)), 'home_copy_missing');
  assert.equal(a.home.status().home.state, 'moving', 'nothing changed: the target keeps the good copy');
  const { default: methods } = await import('../shared/host/methods/momo.mjs' as any);
  const parse = methods({ bad: (m: string) => new Error(m), matchOf: (v: any) => v }).methods['host.momoMove'].parse;
  assert.throws(() => parse({ op: 'reclaim', moveId: 'move-0001' }), /owner/);
  assert.throws(() => parse({ op: 'reclaim', moveId: 'move-0001', ownerConfirmed: true }), /other machine/);
  assert.deepEqual(parse({ ...ask, op: 'reclaim' }), { op: 'reclaim', moveId: 'move-0001', ownerConfirmed: true, target: 'lost' });
});

test('the owner reclaims only after asking the target: one that switched means finish, one that is unreachable or lost the move allows it', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  await untilCopied(a, b);
  await commit(b);
  const switched = await reclaimHere({ moveId: 'move-0001', from: a.side, to: b.side, target: B });
  assert.equal(switched.state, 'switched', 'the target committed: the move is finished, not reclaimed');
  assert.equal(a.home.status().home?.state ?? 'none', 'none');
  // a target that cannot be reached at all
  const c = await studio(t);
  const d = await host(t, B);
  await untilCopied(c, d);
  const gone = { call: async () => Promise.reject(new Error('connect ECONNREFUSED')), status: async () => ({ home: null }) };
  assert.equal((await reclaimHere({ moveId: 'move-0001', from: c.side, to: gone, target: B })).state, 'resumed');
  assert.equal(c.home.status().home.state, 'running');
});
