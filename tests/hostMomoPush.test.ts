// MoMo's push of an approval engine card on a Host (host/src/momoPush.mjs `notify`): a waiting card pushes the fixed kind with opaque handles and the home's lease, a reminder is not pushed again, quiet hours hold it and it is re-checked against the lease when released, and an answer clears it everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createMomoPush } from '../host/src/momoPush.mjs';
// @ts-ignore
import { chatRef } from '../shared/remote/ref.mjs';

const at = (h: number, m = 0, day = 15) => new Date(2030, 0, day, h, m).getTime();
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function world(now = at(12), quiet: { start: number; end: number } | null = null) {
  const sent: any[] = [];
  const reports: string[] = [];
  let linked = [
    { hostId: 'h1', pairId: 'pair1' },
    { hostId: 'h2', pairId: 'pair2' },
  ];
  let fail = false;
  let allowed = true;
  let clock = now;
  let lease: any = { homeId: 'studio', leaseEpoch: 3 };
  let current = true;
  const push = createMomoPush({
    allowed: () => allowed,
    targets: () => linked,
    send: async (hostId: string, req: any) => {
      if (fail) throw new Error('relay is down');
      sent.push({ hostId, ...req });
      return 'sent';
    },
    settings: () => ({ previews: false, tellNowMax: 6, zone: ZONE, quiet }),
    report: (m: string) => reports.push(m),
    now: () => clock,
    stamp: () => lease,
    current: () => current,
  });
  return {
    push,
    sent,
    reports,
    setLinked: (l: any[]) => (linked = l),
    fail: (v: boolean) => (fail = v),
    allow: (v: boolean) => (allowed = v),
    setNow: (n: number) => (clock = n),
    setLease: (l: any) => (lease = l),
    setCurrent: (v: boolean) => (current = v),
  };
}
const card = (kind: string, requestId = 'r1', chatId = 'claude:m1') => ({ kind, chatId, card: { requestId } });

test('a card that waits pushes the fixed kind to each phone with opaque handles and the home’s lease, a reminder is not pushed again, and its clearing replaces it', async () => {
  const w = world();
  await w.push.notify(card('needsYou'));
  assert.deepEqual(
    w.sent.map((s) => [s.hostId, s.pair, s.kind, s.ref, s.card, 'sealedStamp' in s, 'sealed' in s]),
    [
      ['h1', 'pair1', 'momoNeedsYou', chatRef('pair1', 'claude:m1'), chatRef('pair1', 'r1'), false, false],
      ['h2', 'pair2', 'momoNeedsYou', chatRef('pair2', 'claude:m1'), chatRef('pair2', 'r1'), false, false],
    ],
  );
  assert.doesNotMatch(JSON.stringify(w.sent), /claude:m1|"r1"/, 'no chat or card id in a request');
  // the notification is already on the phone: a reminder says nothing more, and a pause says nothing either
  w.sent.length = 0;
  await w.push.notify(card('reminder'));
  await w.push.notify(card('paused'));
  assert.equal(w.sent.length, 0);
  // the clearing goes once, to the phones that were pushed to, and says nothing of the card
  await w.push.notify({ kind: 'cleared', chatId: 'claude:m1' });
  assert.deepEqual(
    w.sent.map((s) => [s.kind, 'card' in s]),
    [
      ['cleared', false],
      ['cleared', false],
    ],
  );
  w.sent.length = 0;
  await w.push.notify({ kind: 'cleared', chatId: 'claude:m1' });
  await w.push.notify({ kind: 'cleared', chatId: 'claude:never' });
  assert.equal(w.sent.length, 0, 'a clearing with no push before it sends nothing');
  // a card with no id still pushes, with no handle for it, and a question card is a question
  await w.push.notify({ kind: 'needsYou', chatId: 'claude:m2' });
  assert.equal('card' in w.sent[0], false);
  await w.push.notify({ kind: 'needsYou', chatId: 'claude:m3', card: { requestId: 'q1', cardKind: 'question' } });
  assert.equal(w.sent.length, 4);
});

test('with no phone linked nothing is pushed and the Host says so; a relay that fails is reported and the card still waits; a repeat of the same card is not pushed twice', async () => {
  const w = world();
  w.setLinked([]);
  await w.push.notify(card('needsYou'));
  assert.equal(w.sent.length, 0);
  assert.match(w.reports.join(), /no phone is linked/);
  w.setLinked([{ hostId: 'h1', pairId: 'pair1' }]);
  w.fail(true);
  await w.push.notify(card('needsYou'));
  assert.match(w.reports.join(), /MoMo push: relay is down/);
  w.fail(false);
  await w.push.notify(card('needsYou'));
  await w.push.notify(card('needsYou'));
  assert.equal(w.sent.length, 1, 'once');
});

test('quiet hours hold a card, kept until a tick finds them over; a card answered meanwhile is never pushed; and the lease is checked again at release', async () => {
  const night = { start: 22 * 60, end: 7 * 60 };
  const w = world(at(23), night);
  await w.push.notify(card('needsYou', 'r1'));
  assert.equal(w.sent.length, 0, 'held');
  assert.deepEqual(await w.push.release(), { sent: 0, dropped: 0, cleared: 0 }, 'still quiet');
  // the newest of a card key replaces the older
  w.setNow(at(7, 1, 16));
  assert.equal((await w.push.release()).sent, 1);
  assert.deepEqual(
    w.sent.map((s) => s.card),
    [chatRef('pair1', 'r1'), chatRef('pair2', 'r1')],
  );
  // answered during quiet hours: nothing at their end
  w.sent.length = 0;
  w.setNow(at(23, 0, 16));
  await w.push.notify(card('needsYou', 'r3', 'claude:m3'));
  await w.push.notify({ kind: 'cleared', chatId: 'claude:m3' });
  w.setNow(at(7, 1, 17));
  assert.equal((await w.push.release()).sent, 0);
  assert.equal(w.sent.length, 0);
  // a card held at 23:00 whose home moved, or whose grant was revoked, at 02:00 is not pushed at 07:00
  const moved = world(at(23), night);
  await moved.push.notify(card('needsYou', 'r9'));
  moved.setCurrent(false);
  moved.setNow(at(7, 1, 16));
  assert.equal((await moved.push.release()).sent, 0);
  const revoked = world(at(23), night);
  await revoked.push.notify(card('needsYou', 'r9'));
  revoked.allow(false);
  revoked.setNow(at(7, 1, 16));
  assert.equal((await revoked.push.release()).sent, 0);
  assert.equal(revoked.sent.length, 0);
  const awayNow = world(at(23), night);
  await awayNow.push.notify(card('needsYou', 'r9'));
  awayNow.setLease(null);
  awayNow.setNow(at(7, 1, 16));
  assert.equal((await awayNow.push.release()).sent, 0);
});

test('a card that ran out its time pauses the run and its held push is dropped; a MoMo that is not allowed here pushes nothing', async () => {
  const w = world(at(23), { start: 22 * 60, end: 7 * 60 });
  await w.push.notify(card('needsYou', 'r1'));
  await w.push.notify(card('paused', 'r1'));
  w.setNow(at(7, 1, 16));
  assert.equal((await w.push.release()).sent, 0);
  const off = world();
  off.allow(false);
  assert.equal(await off.push.notify(card('needsYou')), undefined);
  assert.equal(off.sent.length, 0);
});

test('defaults fail closed: with no lease given nothing is pushed', async () => {
  const sent: any[] = [];
  const push = createMomoPush({
    allowed: () => true,
    targets: () => [{ hostId: 'h1', pairId: 'pair1' }],
    send: async (_h: string, r: any) => (sent.push(r), 'sent'),
  });
  assert.deepEqual(await push.tell({ kind: 'reply', key: 'a' }), { status: 'not-home' });
  assert.deepEqual(await push.release(), { sent: 0, dropped: 0, cleared: 0 });
  assert.equal(sent.length, 0);
});

test('with only what a push needs given, the defaults are the quiet 22:00-08:00 of the host’s own zone, no report, no receiver check, and a lease that must be confirmed', async () => {
  const noon = new Date(2030, 0, 15, 12).getTime();
  const sent: any[] = [];
  const base = {
    allowed: () => true,
    targets: () => [{ hostId: 'h1', pairId: 'pair1' }],
    send: async (_h: string, r: any) => (sent.push(r), 'sent'),
    now: () => noon,
  };
  // a lease nobody confirms is not one to push under: refused with the default (silent) report
  const unconfirmed = createMomoPush({ ...base, stamp: () => ({ homeId: 'studio', leaseEpoch: 1 }) });
  assert.deepEqual(await unconfirmed.tell({ kind: 'reply', key: 'a' }), { status: 'not-home' });
  assert.equal(sent.length, 0);
  // confirmed, at noon, in the default settings: pushed
  const confirmed = createMomoPush({ ...base, stamp: () => ({ homeId: 'studio', leaseEpoch: 1 }), current: () => true });
  assert.equal((await confirmed.tell({ kind: 'reply', key: 'a' })).status, 'sent');
  // and at 23:00 the default quiet hours hold it
  const night = createMomoPush({
    ...base,
    now: () => new Date(2030, 0, 15, 23).getTime(),
    stamp: () => ({ homeId: 'studio', leaseEpoch: 1 }),
    current: () => true,
  });
  assert.equal((await night.tell({ kind: 'reply', key: 'b' })).status, 'held');
});
