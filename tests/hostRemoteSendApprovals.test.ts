// Approval cards on a chat that runs on a remote machine (electron/host/remoteSend.cjs onSessionPatch, electron/app/sessions.cjs): a card nobody answers for a period is one timeout, the third in a row stops the run on the machine and tells the user, an answer starts the count over, and a person writing to the chat takes it off pause.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world, msg, UUID, code } from './support/host/remoteSendKit.ts';
const require = createRequire(import.meta.url);
const { localHostFor } = require('../electron/host/wiring.cjs');

const MS = 10 * 60_000;
const cards = (n: number) => ({ approvals: Array.from({ length: n }, (_, i) => ({ id: `a${i}` })) });

test('a card answered inside the period costs nothing (A1)', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.service.onSessionPatch({ chatId: 'c1', patch: cards(1) });
  w.clock.advance(MS - 1);
  w.service.onSessionPatch({ chatId: 'c1', patch: cards(0) });
  w.clock.advance(MS * 5);
  assert.equal(w.host.stops.length, 0);
  assert.deepEqual(w.pauses, []);
  assert.equal(w.clock.pending, 0, 'no timer is left behind');
});

test('three periods in a row with the card unanswered stop the run once and tell the user (A2)', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.service.onSessionPatch({ chatId: 'c1', patch: cards(1) });
  w.clock.advance(MS * 2);
  assert.equal(w.host.stops.length, 0);
  w.clock.advance(MS);
  assert.equal(w.host.stops.length, 1);
  assert.equal(w.host.stops[0][0], 'c1');
  assert.deepEqual(w.pauses, ['c1']);
  w.clock.advance(MS * 10);
  assert.equal(w.host.stops.length, 1, 'paused once');
  assert.equal(w.clock.pending, 0);
});

test('an answer starts the count over; more cards arriving do not (W1)', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.service.onSessionPatch({ chatId: 'c1', patch: cards(2) });
  w.clock.advance(MS * 2);
  w.service.onSessionPatch({ chatId: 'c1', patch: cards(3) });
  w.clock.advance(MS - 1);
  assert.equal(w.host.stops.length, 0);
  // one of the three is answered: the two periods already spent are forgiven
  w.service.onSessionPatch({ chatId: 'c1', patch: cards(2) });
  w.clock.advance(MS * 2);
  assert.equal(w.host.stops.length, 0);
  w.clock.advance(MS);
  assert.equal(w.host.stops.length, 1);
});

test('two chats count on their own, whatever their ids look like (I1)', async (t) => {
  const w = world(t);
  w.remote('../__proto__|a');
  w.remote('c2');
  w.service.onSessionPatch({ chatId: '../__proto__|a', patch: cards(1) });
  w.clock.advance(MS * 2);
  w.service.onSessionPatch({ chatId: 'c2', patch: cards(1) });
  w.clock.advance(MS);
  assert.deepEqual(
    w.host.stops.map((s) => s[0]),
    ['../__proto__|a'],
  );
  w.clock.advance(MS * 2);
  assert.deepEqual(
    w.host.stops.map((s) => s[0]),
    ['../__proto__|a', 'c2'],
  );
});

test('a chat that runs here, a patch without cards and a disposed service do nothing', async (t) => {
  const w = world(t);
  w.service.onSessionPatch({ chatId: 'here', patch: cards(1) });
  w.remote('c1');
  w.service.onSessionPatch({ chatId: 'c1', patch: {} });
  w.service.onSessionPatch({ chatId: 'c1', patch: undefined });
  w.service.onSessionPatch({ chatId: 'c1', patch: cards(0) });
  assert.equal(w.clock.pending, 0);
  w.service.onSessionPatch({ chatId: 'c1', patch: cards(1) });
  assert.equal(w.clock.pending, 1);
  w.service.dispose();
  assert.equal(w.clock.pending, 0, 'disposing ends the period');
  w.service.onSessionPatch({ chatId: 'c1', patch: cards(1) });
  assert.equal(w.clock.pending, 0);
});

test('a stop that cannot be sent is not claimed and is tried again after the next period; a failed stop is reported (B1)', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.config.hostFor = () => null as any;
  w.service.onSessionPatch({ chatId: 'c1', patch: cards(1) });
  w.clock.advance(MS * 3);
  assert.deepEqual(w.pauses, []);
  assert.equal(w.reports.length, 1);
  w.config.hostFor = () => w.host as any;
  w.host.stop = async () => {
    throw code('down', 'host_unreachable');
  };
  w.clock.advance(MS);
  assert.deepEqual(w.pauses, ['c1']);
  await new Promise((r) => setImmediate(r));
  assert.equal(w.reports.length, 2, 'the failed stop is reported');
});

test('a person writing to the paused chat takes it off pause: three more periods pause it again (A3)', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.service.onSessionPatch({ chatId: 'c1', patch: cards(1) });
  w.clock.advance(MS * 3);
  assert.equal(w.host.stops.length, 1);
  w.service.onSessionPatch({ chatId: 'c1', patch: cards(0) });
  await w.service.send('c1', msg('go on', UUID(1)), 1);
  w.service.onSessionPatch({ chatId: 'c1', patch: cards(1) });
  w.clock.advance(MS * 3);
  assert.equal(w.host.stops.length, 2);
});

test('the session store’s publish feeds the cards of every harness to the service, and only cards (A4)', () => {
  const seen: unknown[] = [];
  let service: any = { onSessionPatch: (p: unknown) => seen.push(p) };
  const published: unknown[] = [];
  const sessions: any = { has: () => true, snapshot: () => ({ rev: 1 }), publish: (p: unknown) => published.push(p) };
  localHostFor({ live: { chats: { records: new Map() }, remoteSend: () => service }, controller: {}, sessions, claudeTurns: {} });
  sessions.publish({ chatId: 'c1', rev: 1, patch: { turn: 'running' } });
  sessions.publish({ chatId: 'c1', rev: 2, patch: { approvals: [] } });
  sessions.publish({ chatId: 'c1', rev: 3, patch: { approvals: [{ id: 'a' }] } });
  assert.deepEqual(
    seen.map((p: any) => p.rev),
    [2, 3],
  );
  assert.equal(published.length, 3, 'the windows still get every patch');
  service = null;
  sessions.publish({ chatId: 'c1', rev: 4, patch: { approvals: [{ id: 'a' }] } });
  assert.equal(seen.length, 2, 'Host off: nothing is told');
  assert.equal(published.length, 4);
});

test('a store opened before the service exists publishes as before', () => {
  const published: unknown[] = [];
  const sessions: any = { has: () => true, snapshot: () => ({ rev: 1 }), publish: (p: unknown) => published.push(p) };
  localHostFor({ live: { chats: { records: new Map() } }, controller: {}, sessions, claudeTurns: {} });
  sessions.publish({ chatId: 'c1', rev: 1, patch: { approvals: [{ id: 'a' }] } });
  assert.equal(published.length, 1);
});
