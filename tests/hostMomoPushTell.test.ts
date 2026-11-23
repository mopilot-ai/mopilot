// MoMo's push of notices on a Host (host/src/momoPush.mjs `tell`, `answered`, `release`, `failures`): one wire kind with the home's lease, the daily tell-now cap (never on an approval), dedupe across a restart, quiet hours that nothing breaks through and that survive a restart, sealed previews only on opt-in, clearing on the other devices with retries, failure causes with their one-tap fix, and the lease fence at every step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { pushShape } from '../host/src/momoPush.mjs';
// @ts-ignore
import { chatRef } from '../shared/remote/ref.mjs';

import { NY, tick, wall, world } from './support/host/momoPushWorld.ts';

test('every kind goes to the relay as the one fixed kind with opaque handles, the home’s lease and no text, to each phone', async () => {
  const w = world();
  for (const kind of ['reply', 'question', 'approval', 'brief', 'catchUp']) {
    const r = await w.push.tell({ kind, key: `k-${kind}`, chatId: 'chat1', cardId: 'card1', text: 'Dana wants the quote' });
    assert.deepEqual(r, { status: 'sent', sent: 2 });
  }
  assert.equal(w.sent.length, 10);
  assert.ok(
    w.sent.every(
      (r: any) =>
        r.kind === 'momoNeedsYou' && !('sealedBody' in r) && !('homeId' in r) && !('leaseEpoch' in r) && typeof r.sealedStamp === 'string',
    ),
  );
  assert.deepEqual(w.sent[0], {
    hostId: 'h1',
    pair: 'pair1',
    kind: 'momoNeedsYou',
    ref: chatRef('pair1', 'chat1'),
    card: chatRef('pair1', 'card1'),
    sealedStamp: w.sent[0].sealedStamp,
  });
  const x = world();
  await x.push.tell({ kind: 'brief', key: 'b1' });
  assert.equal(x.sent[0].ref, chatRef('pair1', 'momo'));
  assert.equal('card' in x.sent[0], false);
});

test('a question that carries its card is a card a run waits on: the cap never refuses or drops it, a tell-now question still counts', async () => {
  const w = world();
  for (const key of ['a', 'b', 'c']) await w.push.tell({ kind: 'reply', key });
  assert.equal((await w.push.tell({ kind: 'question', key: 'plain' })).status, 'capped');
  const card = await w.push.tell({ kind: 'question', key: 'q-card', cardId: 'q-card', chatId: 'chat1' });
  assert.equal(card.status, 'sent', 'a card is not a tell-now item');
});

test('the daily cap counts reply and question but never an approval, a brief or a catch-up; the next day starts again', async () => {
  const w = world();
  assert.equal((await w.push.tell({ kind: 'reply', key: 'a' })).status, 'sent');
  assert.equal((await w.push.tell({ kind: 'question', key: 'b' })).status, 'sent');
  assert.equal((await w.push.tell({ kind: 'reply', key: 'c' })).status, 'sent');
  assert.equal((await w.push.tell({ kind: 'reply', key: 'd' })).status, 'capped');
  assert.equal(
    (await w.push.tell({ kind: 'approval', key: 'card9' })).status,
    'sent',
    'an approval a run is blocked on always reaches the phone',
  );
  assert.equal((await w.push.tell({ kind: 'brief', key: 'brief:1' })).status, 'sent');
  assert.equal((await w.push.tell({ kind: 'catchUp', key: 'catch:1' })).status, 'sent');
  w.set(wall(NY, '2026-11-24', '12:00'));
  assert.equal((await w.push.tell({ kind: 'reply', key: 'd' })).status, 'sent');
});

test('the same key is never pushed twice, across a restart too; a push no phone received gives its place back', async () => {
  const w = world();
  assert.equal((await w.push.tell({ kind: 'reply', key: 'dana-1' })).status, 'sent');
  assert.equal((await w.push.tell({ kind: 'reply', key: 'dana-1' })).status, 'duplicate');
  assert.equal((await w.make().tell({ kind: 'reply', key: 'dana-1' })).status, 'duplicate');
  assert.equal(w.sent.length, 2, 'two phones, one push');

  const f = world();
  f.state.status = () => new Error('relay is down');
  assert.deepEqual(await f.push.tell({ kind: 'reply', key: 'x' }), { status: 'failed' });
  f.state.status = () => 'sent';
  assert.equal((await f.push.tell({ kind: 'reply', key: 'x' })).status, 'sent', 'a later try can go out');
  const g = world();
  g.state.status = () => 'no_token';
  for (const k of ['1', '2', '3', '4']) assert.equal((await g.push.tell({ kind: 'reply', key: k })).status, 'failed');
  g.state.status = () => 'sent';
  assert.equal((await g.push.tell({ kind: 'reply', key: '5' })).status, 'sent', 'failed pushes did not use up the cap');
});

test('nothing breaks through quiet hours: held to their end and kept across a restart, a held brief is dropped for the new one, the rest goes once', async () => {
  const w = world({ at: wall(NY, '2026-11-23', '23:00') });
  assert.deepEqual(await w.push.tell({ kind: 'reply', key: 'late', text: 'first' }), {
    status: 'held',
    until: wall(NY, '2026-11-24', '08:00'),
  });
  await w.push.tell({ kind: 'reply', key: 'late', text: 'second' });
  await w.push.tell({ kind: 'brief', key: 'brief:x' });
  await w.push.tell({ kind: 'catchUp', key: 'catch:x' });
  assert.equal(w.sent.length, 0);
  // still quiet: nothing; a restart in the night keeps what was held
  assert.deepEqual(await w.make().release(), { sent: 0, dropped: 0, cleared: 0 });
  w.set(wall(NY, '2026-11-24', '08:00'));
  const after = w.make();
  assert.deepEqual(await after.release(), { sent: 1, dropped: 2, cleared: 0 });
  assert.equal(w.sent.length, 2, 'one held item, two phones');
  assert.deepEqual(await after.release(), { sent: 0, dropped: 0, cleared: 0 }, 'once');
  // the owner moved quiet hours: still held
  const x = world({ at: wall(NY, '2026-11-23', '23:00') });
  await x.push.tell({ kind: 'reply', key: 'k' });
  x.state.settings = { ...x.state.settings, quiet: { start: 22 * 60, end: 10 * 60 } };
  x.set(wall(NY, '2026-11-24', '08:00'));
  assert.equal((await x.push.release()).sent, 0);
  // an answered item held for quiet hours is never sent
  const y = world({ at: wall(NY, '2026-11-23', '23:00') });
  await y.push.tell({ kind: 'reply', key: 'gone' });
  await y.push.answered('gone');
  y.set(wall(NY, '2026-11-24', '08:00'));
  assert.equal((await y.push.release()).sent, 0);
});

test('a push held through the night is checked against the lease when it is released: a home that moved, a revoked grant or a lost lease send nothing', async () => {
  for (const spoil of [(w: any) => (w.state.current = false), (w: any) => (w.state.allowed = false), (w: any) => (w.state.stamp = null)]) {
    const w = world({ at: wall(NY, '2026-11-23', '23:00') });
    await w.push.tell({ kind: 'approval', key: 'card1', cardId: 'card1' });
    spoil(w);
    w.set(wall(NY, '2026-11-24', '08:00'));
    assert.deepEqual(await w.push.release(), { sent: 0, dropped: 0, cleared: 0 });
    assert.equal(w.sent.length, 0);
  }
  // the lease moves between the reservation and the send: refused, and the place in the day is given back
  const x = world();
  x.state.settings = { ...x.state.settings, tellNowMax: 1 };
  let flipped = false;
  x.state.told = () => {
    if (!flipped) x.state.current = false;
    flipped = true;
    return true;
  };
  x.push = x.make();
  assert.deepEqual(await x.push.tell({ kind: 'reply', key: 'a' }), { status: 'not-home' });
  assert.match(x.reports.join(), /moved on/);
  x.state.current = true;
  assert.equal((await x.push.tell({ kind: 'reply', key: 'a' })).status, 'sent');
  // a release that is already going does not start a second
  const y = world({ at: wall(NY, '2026-11-23', '23:00') });
  await y.push.tell({ kind: 'reply', key: 'k' });
  y.set(wall(NY, '2026-11-24', '08:00'));
  const [a, b] = await Promise.all([y.push.release(), y.push.release()]);
  assert.equal(a.sent + b.sent, 1);
});

test('lock-screen text is sealed end to end and only when previews are on and the Host can seal it', async () => {
  const w = world();
  w.state.settings = { ...w.state.settings, previews: true };
  await w.push.tell({ kind: 'reply', key: 'a', text: 'Dana replied' });
  assert.ok(
    w.sent.every((r: any) => !('sealedBody' in r)),
    'no sealer: the fixed text, and the Host says so once',
  );
  await w.push.tell({ kind: 'reply', key: 'b', text: 'Dana replied again' });
  assert.equal(w.reports.filter((m: string) => /cannot seal/.test(m)).length, 1);

  const seals: any[] = [];
  const s = world();
  s.state.sealBody = (t: any, ref: string, text: string) => (seals.push({ t, ref, text }), Buffer.from(text).toString('base64url'));
  s.push = s.make();
  s.state.settings = { ...s.state.settings, previews: true };
  await s.push.tell({ kind: 'reply', key: 'a', text: 'Dana replied' });
  assert.equal(s.sent[0].sealedBody, Buffer.from('Dana replied').toString('base64url'));
  assert.equal(seals[0].ref, s.sent[0].ref);
  assert.ok(!JSON.stringify(s.sent).includes('Dana replied'), 'no text in the clear');
  s.state.settings = { ...s.state.settings, previews: false };
  await s.push.tell({ kind: 'reply', key: 'b', text: 'secret' });
  s.state.settings = { ...s.state.settings, previews: true };
  await s.push.tell({ kind: 'reply', key: 'c' });
  assert.equal(seals.length, 2);
  assert.ok(s.sent.slice(2).every((r: any) => !('sealedBody' in r)));
});

test('answering on one device tells the phones that were pushed to, once; a clear that fails is tried again; an answer that races its own push still clears', async () => {
  const w = world();
  await w.push.tell({ kind: 'reply', key: 'dana-1', chatId: 'chat1' });
  w.sent.length = 0;
  assert.equal(await w.push.answered('dana-1'), 2);
  assert.deepEqual(
    w.sent.map((r: any) => [r.hostId, r.kind, r.ref]),
    [
      ['h1', 'cleared', chatRef('pair1', 'chat1')],
      ['h2', 'cleared', chatRef('pair2', 'chat1')],
    ],
  );
  assert.equal(await w.push.answered('dana-1'), 0, 'once');
  assert.equal(await w.push.answered('never-sent'), 0);

  // one relay link fails the clearing: the phone that was told is not told again, the other is tried at the next release
  const x = world();
  await x.push.tell({ kind: 'reply', key: 'k' });
  x.sent.length = 0;
  let down = true;
  x.state.status = (h: string) => (h === 'h1' && down ? 'failed' : 'sent');
  assert.equal(await x.push.answered('k'), 1);
  assert.match(x.reports.join(), /relay refused the clearing/);
  down = false;
  assert.deepEqual(await x.push.release(), { sent: 0, dropped: 0, cleared: 1 });
  assert.deepEqual(
    x.sent.map((r: any) => r.hostId),
    ['h2', 'h1'],
  );
  assert.deepEqual(await x.push.release(), { sent: 0, dropped: 0, cleared: 0 });

  // a clear that keeps failing is given up after its tries
  const y = world();
  await y.push.tell({ kind: 'reply', key: 'k' });
  y.state.status = () => 'failed';
  await y.push.answered('k');
  for (let i = 0; i < 10; i++) await y.push.release();
  const n = y.sent.length;
  await y.push.release();
  assert.equal(y.sent.length, n);

  // the answer comes while the push is still going out: it is cleared as soon as it lands
  const z = world();
  let inFlight: () => void = () => undefined;
  const gate = new Promise<void>((r) => (inFlight = r));
  const sendOriginal = z.state.status;
  z.state.status = (_h: string, req: any) => (req.kind === 'cleared' ? 'sent' : sendOriginal());
  const pending = z.push.tell({ kind: 'reply', key: 'race' });
  await tick();
  const early = z.push.answered('race');
  inFlight();
  await gate;
  await Promise.all([pending, early]);
  assert.ok(z.sent.some((r: any) => r.kind === 'cleared'));
  // a Host that is no longer the home clears nothing now, and does at the next release once it is
  const q = world();
  await q.push.tell({ kind: 'reply', key: 'k' });
  q.state.current = false;
  assert.equal(await q.push.answered('k'), 0);
  q.state.current = true;
  assert.equal((await q.push.release()).cleared, 2);
});

test('a notification button never clears an approval card: only the card’s own answer does', async () => {
  const w = world();
  await w.push.tell({ kind: 'approval', key: 'card1', cardId: 'card1' });
  w.sent.length = 0;
  assert.equal(await w.push.answered('card1', { by: 'button' }), 0);
  assert.equal(w.sent.length, 0);
  assert.equal(await w.push.answered('card1', { by: 'card' }), 2);
  // keys this home issued, and whether a button already did its work, survive a restart
  assert.equal(w.push.knows('card1'), true);
  assert.equal(w.push.knows('made-up'), false);
  await w.push.markIntent('card1', true);
  assert.equal(w.make().intentDone('card1'), true);
  await w.push.markIntent('card1', false);
  assert.equal(w.push.intentDone('card1'), false);
  await w.push.markIntent('made-up', true);
  assert.equal(w.push.intentDone('made-up'), false);
});

test('failures say the real cause and the one-tap fix: notifications off, a token that went bad, the relay down, push disabled; a good push clears them', async () => {
  const w = world();
  w.state.status = () => 'no_token';
  await w.push.tell({ kind: 'reply', key: 'a' });
  assert.deepEqual(
    w.push.failures().map((f: any) => [f.pairId, f.code, f.id]),
    [
      ['pair1', 'notifications_off', 'open_settings'],
      ['pair2', 'notifications_off', 'open_settings'],
    ],
  );
  assert.match(w.push.failures()[0].cause, /Notifications are off/);
  w.state.status = () => 'sent';
  await w.push.tell({ kind: 'reply', key: 'b' });
  assert.deepEqual(w.push.failures(), []);
  w.state.status = () => 'no_token';
  await w.push.tell({ kind: 'reply', key: 'c' });
  assert.deepEqual(
    w.push.failures().map((f: any) => [f.code, f.id, f.label]),
    [
      ['token_invalid', 'pair_again', 'Pair again'],
      ['token_invalid', 'pair_again', 'Pair again'],
    ],
  );
  w.state.status = () => new Error('relay is down');
  await w.push.tell({ kind: 'brief', key: 'd' });
  assert.equal(w.push.failures()[0].code, 'relay_unreachable');
  w.state.status = () => 'disabled';
  await w.push.tell({ kind: 'brief', key: 'e' });
  assert.equal(w.push.failures()[0].code, 'push_disabled');
  const x = world();
  x.state.status = () => Object.assign(new Error('unknown kind'), { code: 'bad_message' });
  await x.push.tell({ kind: 'brief', key: 'd' });
  assert.deepEqual(x.push.failures(), []);
  const y = world();
  y.state.status = () => 'suppressed';
  assert.equal((await y.push.tell({ kind: 'brief', key: 'd' })).status, 'failed');
  assert.deepEqual(y.push.failures(), []);
});

test('nothing goes when MoMo is off here, this Host is not the home, the lease moved, no phone is linked, or the item is malformed', async () => {
  const w = world();
  w.state.allowed = false;
  assert.deepEqual(await w.push.tell({ kind: 'reply', key: 'a' }), { status: 'off' });
  w.state.allowed = true;
  w.state.stamp = null;
  assert.deepEqual(await w.push.tell({ kind: 'reply', key: 'a' }), { status: 'not-home' });
  w.state.stamp = { homeId: 'studio', leaseEpoch: 1 };
  assert.deepEqual(await w.push.tell({ kind: 'nope', key: 'a' }), { status: 'invalid' });
  assert.deepEqual(await w.push.tell({ kind: 'reply', key: '' }), { status: 'invalid' });
  assert.deepEqual(await w.push.tell(null), { status: 'invalid' });
  w.state.linked = [];
  assert.deepEqual(await w.push.tell({ kind: 'reply', key: 'a' }), { status: 'no_phone' });
  assert.match(w.reports.join(), /no phone is linked/);
  w.state.linked = [{ hostId: 'h1', pairId: 'pair1' }];
  w.state.current = false;
  assert.deepEqual(await w.push.tell({ kind: 'reply', key: 'a' }), { status: 'not-home' });
  w.state.current = true;
  assert.equal((await w.push.tell({ kind: 'reply', key: 'a' })).status, 'sent', 'the refused one gave its place back');
  assert.equal(w.sent.length, 1);
});

test('a store with old entries drops them after two days, and a bad file reads as an empty day', async () => {
  assert.deepEqual(pushShape(null), { day: '', count: 0, sent: {}, held: {} });
  assert.deepEqual(pushShape({ day: 5, count: -1, sent: [], held: [] }), { day: '', count: 0, sent: {}, held: {} });
  const w = world();
  await w.push.tell({ kind: 'reply', key: 'old' });
  w.set(wall(NY, '2026-11-26', '12:00'));
  assert.equal((await w.push.tell({ kind: 'reply', key: 'old' })).status, 'sent');
});
