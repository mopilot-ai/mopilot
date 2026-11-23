// MoMo's push, the lease and the notice store's counter (host/src/momoPush.mjs `tell`, `cardChanged`): the stamp sealed for each phone alone, a stale lease sends nothing, the gate's cards, the day's count kept by the notice store: one wire kind with the home's lease, the daily tell-now cap (never on an approval), dedupe across a restart, quiet hours that nothing breaks through and that survive a restart, sealed previews only on opt-in, clearing on the other devices with retries, failure causes with their one-tap fix, and the lease fence at every step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createMomoPush } from '../host/src/momoPush.mjs';
// @ts-ignore
import { chatRef } from '../shared/remote/ref.mjs';

import { NY, rootOf, stamps, prim, wall, world } from './support/host/momoPushWorld.ts';

test('the notice store counts the day when it has the counter: the Host counts none, and a refusal or a failed push gives the count back', async () => {
  const claims: any[] = [];
  const gave: any[] = [];
  const w = world();
  let allow = true;
  w.state.told = (a: any) => (claims.push(a), allow);
  w.state.untold = (a: any) => void gave.push(a);
  w.push = w.make();
  assert.equal((await w.push.tell({ kind: 'reply', key: 'a' })).status, 'sent');
  assert.equal((await w.push.tell({ kind: 'reply', key: 'b' })).status, 'sent', 'the Host has no count of its own');
  assert.deepEqual(claims[0], { day: '2026-11-23', max: 3, key: 'a' });
  assert.equal((await w.push.tell({ kind: 'brief', key: 'brief:1' })).status, 'sent');
  assert.equal(claims.length, 2, 'a brief is not counted');
  allow = false;
  assert.equal((await w.push.tell({ kind: 'reply', key: 'c' })).status, 'capped');
  assert.deepEqual(gave, [{ day: '2026-11-23', key: 'c' }]);
  allow = true;
  w.state.status = () => 'failed';
  assert.equal((await w.push.tell({ kind: 'reply', key: 'c' })).status, 'failed');
  assert.deepEqual(gave.at(-1), { day: '2026-11-23', key: 'c' });
  w.state.status = () => 'sent';
  assert.equal((await w.push.tell({ kind: 'reply', key: 'c' })).status, 'sent', 'the refused key can go again');
});

test('reachedAny is false until a push reached a phone, and true after a restart that finds one in the store', async () => {
  const w = world();
  assert.equal(w.push.reachedAny(), false);
  await w.push.tell({ kind: 'reply', key: 'a' });
  assert.equal(w.push.reachedAny(), true);
  await w.push.answered('a');
  assert.equal(w.make().reachedAny(), true, 'even after its notification was cleared');
});

test('the gate hook: an open card is pushed as an approval, an answered or expired one is cleared everywhere, the rest is ignored', async () => {
  const w = world();
  assert.equal((await w.push.cardChanged({ cardId: 'card12', status: 'open', chatId: 'chat1' })).status, 'sent');
  assert.equal(w.sent[0].card, chatRef('pair1', 'card12'));
  assert.equal((await w.push.cardChanged({ cardId: 'card13', status: 'open' })).status, 'sent');
  w.sent.length = 0;
  assert.deepEqual(await w.push.cardChanged({ cardId: 'card12', status: 'allowed' }), { status: 'cleared', told: 2 });
  assert.equal(w.sent.length, 2);
  assert.deepEqual(await w.push.cardChanged({ cardId: 'card13', status: 'expired' }), { status: 'cleared', told: 2 });
  assert.deepEqual(await w.push.cardChanged({ cardId: 'card13', status: 'denied' }), { status: 'cleared', told: 0 });
  assert.deepEqual(await w.push.cardChanged({ cardId: 'card13', status: 'used' }), { status: 'ignored' });
});

test('a push stamped with an older lease than the newest the home has seen is not sent, at the push or when a held one is released', async () => {
  const w = world();
  w.state.stale = true;
  assert.deepEqual(await w.push.tell({ kind: 'reply', key: 'a' }), { status: 'not-home' });
  assert.equal(w.sent.length, 0);
  assert.match(w.reports.join(), /moved on/);
  w.state.stale = false;
  assert.equal((await w.push.tell({ kind: 'reply', key: 'a' })).status, 'sent', 'the refused one gave its place back');
  // held through the night, and a newer lease is seen before the morning
  const h = world({ at: wall(NY, '2026-11-23', '23:00') });
  await h.push.tell({ kind: 'approval', key: 'card1', cardId: 'card1' });
  h.state.stale = true;
  h.set(wall(NY, '2026-11-24', '08:00'));
  assert.deepEqual(await h.push.release(), { sent: 0, dropped: 0, cleared: 0 });
  assert.equal(h.sent.length, 0);
});

test('a counted push that reached no phone gives its count back to the notice store, which needs no give-back hook of its own to be given one', async () => {
  const w = world();
  const claims: any[] = [];
  w.state.told = (a: any) => (claims.push(a), true);
  w.push = w.make();
  w.state.status = () => 'failed';
  assert.equal((await w.push.tell({ kind: 'reply', key: 'a' })).status, 'failed');
  assert.equal(claims.length, 1);
});

test('the lease is sealed for each phone alone: it opens only with that phone’s root and push, the relay-side request shows no home id or epoch, and a stamp that is not one is not sent', async () => {
  const w = world();
  await w.push.tell({ kind: 'reply', key: 'a', chatId: 'chat1' });
  assert.doesNotMatch(JSON.stringify(w.sent), /studio|leaseEpoch/);
  const [one, two] = w.sent;
  const open = (r: any, root: Uint8Array, ref = r.ref) => stamps.open({ sealed: r.sealedStamp, ref, keys: [stamps.stampKey(root)] });
  assert.deepEqual(open(one, rootOf('pair1')), { homeId: 'studio', leaseEpoch: 1 });
  assert.deepEqual(open(two, rootOf('pair2')), { homeId: 'studio', leaseEpoch: 1 });
  // another phone's root, another push's handle, a tampered blob, a truncated one and a wrong version open nothing
  assert.equal(open(one, rootOf('pair2')), null);
  assert.equal(open(one, rootOf('pair1'), chatRef('pair1', 'other')), null);
  assert.equal(open({ ...one, sealedStamp: one.sealedStamp.slice(0, -2) + 'AA' }, rootOf('pair1')), null);
  assert.equal(open({ ...one, sealedStamp: one.sealedStamp.slice(0, 20) }, rootOf('pair1')), null);
  assert.equal(open({ ...one, sealedStamp: 'A'.repeat(80) }, rootOf('pair1')), null, 'a version nobody wrote');
  assert.equal(open({ ...one, sealedStamp: 'AAAA'.repeat(80) }, rootOf('pair1')), null, 'longer than a stamp ever is');
  assert.equal(open({ ...one, sealedStamp: '!!!' }, rootOf('pair1')), null);
  assert.equal(stamps.open({ sealed: one.sealedStamp, ref: one.ref, keys: [new Uint8Array(5)] }), null);
  // a blob that is authentic but not a stamp (made by someone holding the key) opens nothing
  const forge = (text: string) => {
    const nonce = prim.randomBytes(24);
    const box = prim.aeadSeal(
      stamps.stampKey(rootOf('pair1')),
      nonce,
      new TextEncoder().encode(text),
      new TextEncoder().encode(`mopilot-push-stamp-v1|${one.ref}`),
    );
    const out = new Uint8Array(1 + 24 + box.length);
    out[0] = 1;
    out.set(nonce, 1);
    out.set(box, 25);
    return Buffer.from(out).toString('base64url');
  };
  assert.equal(open({ ...one, sealedStamp: forge('not json') }, rootOf('pair1')), null);
  assert.equal(open({ ...one, sealedStamp: forge('{"h":1,"e":2}') }, rootOf('pair1')), null);
  assert.equal(open({ ...one, sealedStamp: forge('{"h":"studio","e":2}') }, rootOf('pair1'))?.leaseEpoch, 2);
  // a stamp the seal refuses (no home, an epoch that is not a positive integer, a home id too long) is not carried at all
  const key = stamps.stampKey(rootOf('pair1'));
  for (const bad of [
    { homeId: '', leaseEpoch: 1 },
    { homeId: 'x'.repeat(65), leaseEpoch: 1 },
    { homeId: 'studio', leaseEpoch: 0 },
    { homeId: 'studio', leaseEpoch: 1.5 },
    { homeId: 'studio', leaseEpoch: 2 ** 60 },
  ])
    assert.equal(stamps.seal({ key, ref: 'r', ...bad }), null, JSON.stringify(bad));
  // a Host that cannot seal (a phone with no root) sends the push with no stamp
  const bare = createMomoPush({
    allowed: () => true,
    targets: () => [{ hostId: 'h1', pairId: 'pair1' }],
    send: async (_h: string, r: any) => (w.sent.push(r), 'sent'),
    stamp: () => ({ homeId: 'studio', leaseEpoch: 1 }),
    current: () => true,
    sealStamp: () => null,
    now: () => wall(NY, '2026-11-23', '12:00'),
  });
  w.sent.length = 0;
  await bare.tell({ kind: 'reply', key: 'z' });
  assert.equal('sealedStamp' in w.sent[0], false);
});

test('an approval a run waits on is never lost: held through the night and the relay down at 08:00, it stays and goes out when the relay is back; a lease that fails mid-release keeps the rest', async () => {
  const w = world({ at: wall(NY, '2026-11-23', '23:00') });
  await w.push.tell({ kind: 'approval', key: 'card1', cardId: 'card1' });
  await w.push.tell({ kind: 'approval', key: 'card2', cardId: 'card2' });
  w.set(wall(NY, '2026-11-24', '08:00'));
  w.state.status = () => new Error('relay is down');
  assert.deepEqual(await w.push.release(), { sent: 0, dropped: 0, cleared: 0 });
  assert.equal(w.sent.length, 0);
  // still held, with a time to try again: asked too early it leaves them alone
  assert.equal((await w.push.release()).sent, 0);
  w.state.status = () => 'sent';
  w.set(wall(NY, '2026-11-24', '08:00') + 60_000);
  assert.equal((await w.push.release()).sent, 2);
  assert.equal(w.sent.length, 4, 'two cards, two phones');
  assert.equal((await w.push.release()).sent, 0, 'once');

  // the lease is lost after the first of two: the second is still held, not forgotten
  const m = world({ at: wall(NY, '2026-11-23', '23:00') });
  await m.push.tell({ kind: 'approval', key: 'a', cardId: 'a' });
  await m.push.tell({ kind: 'approval', key: 'b', cardId: 'b' });
  m.set(wall(NY, '2026-11-24', '08:00'));
  let calls = 0;
  m.state.status = () => {
    if (++calls === 2) m.state.current = false;
    return 'sent';
  };
  assert.equal((await m.push.release()).sent, 1);
  m.state.current = true;
  assert.equal((await m.push.release()).sent, 1, 'the one the lease stopped goes out under the lease that is back');

  // no phone yet: kept; the phone pairs; it goes
  const n = world({ at: wall(NY, '2026-11-23', '23:00') });
  await n.push.tell({ kind: 'approval', key: 'c', cardId: 'c' });
  n.state.linked = [];
  n.set(wall(NY, '2026-11-24', '08:00'));
  assert.equal((await n.push.release()).sent, 0);
  n.state.linked = [{ hostId: 'h1', pairId: 'pair1' }];
  n.set(wall(NY, '2026-11-24', '08:10'));
  assert.equal((await n.push.release()).sent, 1);
});

test('a push the relay would not take in the daytime is kept and retried with a growing wait, dropped after two days; a brief or catch-up that failed is not kept', async () => {
  const w = world();
  w.state.status = () => new Error('relay is down');
  assert.equal((await w.push.tell({ kind: 'approval', key: 'card1', cardId: 'card1' })).status, 'failed');
  assert.equal((await w.push.tell({ kind: 'brief', key: 'brief:1' })).status, 'failed');
  w.state.status = () => 'sent';
  // the first wait is 30 s, then 60 s, then 120 s…
  w.set(w.now() + 29_000);
  assert.equal((await w.push.release()).sent, 0, 'too early');
  w.state.status = () => new Error('relay is down');
  w.set(w.now() + 2_000);
  await w.push.release();
  w.set(w.now() + 59_000);
  assert.equal(w.sent.length, 0);
  w.state.status = () => 'sent';
  assert.equal((await w.push.release()).sent, 0, 'the second wait is longer');
  w.set(w.now() + 2_000);
  assert.equal((await w.push.release()).sent, 1);
  assert.equal(
    w.sent.some((r: any) => r.ref.includes('momo') && !r.card),
    false,
    'the brief was never kept',
  );
  // a push that has been failing for two days is let go
  const d = world();
  d.state.status = () => new Error('relay is down');
  await d.push.tell({ kind: 'approval', key: 'old', cardId: 'old' });
  d.set(d.now() + 3 * 24 * 60 * 60_000);
  await d.push.release();
  d.state.status = () => 'sent';
  d.set(d.now() + 11 * 60_000);
  assert.equal((await d.push.release()).sent, 0);
});

test('a crash between the reservation and the send does not make a push a duplicate for ever: a recent reservation is one being sent, an old one is taken over, and the day’s count is not taken twice', async () => {
  const w = world();
  w.state.boom = true;
  // the process dies after the reservation was written: whatever escapes the send leaves it behind
  await assert.rejects(w.push.tell({ kind: 'reply', key: 'r1' }), /crash/);
  w.state.boom = false;
  assert.equal((await w.push.tell({ kind: 'reply', key: 'r1' })).status, 'duplicate', 'a minute ago it may still be going out');
  w.set(w.now() + 3 * 60_000);
  assert.equal(
    (await w.push.tell({ kind: 'reply', key: 'r1' })).status,
    'sent',
    'long enough ago, it is a crash and this try takes it over',
  );
  assert.equal(w.sent.length, 2, 'two phones, once');
  // the count was taken once for r1: two more still fit under the cap of three, the next does not
  assert.equal((await w.push.tell({ kind: 'reply', key: 'r2' })).status, 'sent');
  assert.equal((await w.push.tell({ kind: 'reply', key: 'r3' })).status, 'sent');
  assert.equal((await w.push.tell({ kind: 'reply', key: 'r4' })).status, 'capped');
});
