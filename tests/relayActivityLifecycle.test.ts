// The Live Activity's life on the relay: the token a phone registers and Apple retires, the baseline of the update before it, and what happens when a pair leaves or a Mac goes quiet.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, paired as pairedOn, P, idle, settle } from './support/relayKit.ts';
import { parseSnapshot } from '../relay/src/activity.mjs';
import { waitFor } from './support/waitFor.ts';

const { db, reset } = await makeDb();
beforeEach(reset);
const paired = () => pairedOn(db, {});
const TOKEN = 'ab'.repeat(32);
const snap = (o: object = {}) => ({ needs: 1, running: 2, kind: 'needs', since: 1_900_000_000, at: 1_900_000_100, rows: [], ...o });

test('registering the token of a new activity does not end it when the held state is empty', async () => {
  const r = await paired();
  await r.mac.say({ t: 'activity', pair: P, state: snap({ needs: 0, running: 0, kind: 'done', since: 0 }) });
  await r.phone.say({ t: 'activity.register', token: TOKEN });
  assert.equal(r.pushed.length, 0);
  assert.equal(await r.store.activityTokenOf('ph1'), TOKEN);
});

test("Apple's late answer about an ended activity does not remove the token of the next one", async () => {
  const NEXT = 'cd'.repeat(32);
  let release: (() => void) | null = null;
  const sent: any[] = [];
  const r = await pairedOn(db, {
    send: (m: any) =>
      new Promise((resolve) => {
        sent.push(m);
        if (m.token === NEXT) return resolve({ ok: true });
        release = () => resolve({ ok: false, invalidToken: true });
      }),
  });
  await r.phone.say({ t: 'activity.register', token: TOKEN });
  r.mac.h.message(JSON.stringify({ t: 'activity', pair: P, state: snap({ needs: 2 }) }));
  await waitFor(() => release !== null, 'the first activity reaching its provider');
  // the phone ends the activity and starts another while the update is out (the answer does not wait for the provider); Apple then calls the first token dead
  r.phone.h.message(JSON.stringify({ t: 'activity.register', token: NEXT, rid: 'next' }));
  await waitFor(() => r.phone.socket.of('ok').some((m) => m.rid === 'next'), 'the next activity registration acknowledgment');
  assert.equal(r.phone.socket.of('ok').at(-1).rid, 'next');
  release!();
  await settle(r.hub);
  assert.equal(await r.store.activityTokenOf('ph1'), NEXT);
  // the state is sent again to the token that is current
  assert.equal(sent.at(-1).token, NEXT);
});

test('a new activity does not inherit the "needs you" baseline of the one before it', async () => {
  const NEXT = 'cd'.repeat(32);
  const r = await paired();
  await r.phone.say({ t: 'activity.register', token: TOKEN });
  await r.mac.say({ t: 'activity', pair: P, state: snap({ needs: 2 }) });
  assert.equal(r.pushed.at(-1).activity.priority, 10);
  await r.mac.say({ t: 'activity', pair: P, state: snap({ needs: 2 }) });
  assert.equal(r.pushed.at(-1).activity.priority, 5);
  await r.phone.say({ t: 'activity.register', token: NEXT });
  assert.equal(r.pushed.at(-1).token, NEXT);
  assert.equal(r.pushed.at(-1).activity.priority, 10);
});

test("removing a pair refreshes the phone's activity, ends it when no pair is left, and then forgets the token", async () => {
  const r = await paired();
  await r.phone.say({ t: 'activity.register', token: TOKEN });
  await r.mac.say({ t: 'activity', pair: P, state: snap({ needs: 1, running: 0 }) });
  await r.mac.say({ t: 'pair.remove', pair: P });
  const last = r.pushed.at(-1).activity;
  assert.equal(last.event, 'end');
  assert.equal(last.dismissAt, last.timestamp);
  assert.equal(await r.store.activityTokenOf('ph1'), null);
});

test("removing one of two pairs sends the phone the other pair's state", async () => {
  const r = await paired();
  const mac2 = await r.join('u1', 'mac2', 'desktop');
  await mac2.say({ t: 'pair.register', pair: 'p_second0002' });
  await r.phone.say({ t: 'pair.join', pair: 'p_second0002' });
  await r.phone.say({ t: 'activity.register', token: TOKEN });
  await r.mac.say({ t: 'activity', pair: P, state: snap({ needs: 1, running: 0 }) });
  await mac2.say({ t: 'activity', pair: 'p_second0002', state: snap({ needs: 0, running: 4, kind: 'running' }) });
  await r.mac.say({ t: 'pair.remove', pair: P });
  const last = r.pushed.at(-1).activity;
  assert.equal(last.event, 'update');
  assert.deepEqual([last.state.needs, last.state.running], [0, 4]);
  assert.equal(await r.store.activityTokenOf('ph1'), TOKEN);
});

test('a phone whose Mac went quiet is told the activity is over when the snapshot expires, once', async () => {
  const r = await paired();
  await r.phone.say({ t: 'activity.register', token: TOKEN });
  await r.mac.say({ t: 'activity', pair: P, state: snap({ needs: 1, running: 1 }) });
  const before = r.pushed.length;
  r.hub.push.prune(r.clock.now() + 10 * 60_000);
  await settle(r.hub);
  assert.equal(r.pushed.length, before);
  r.clock.advance(31 * 60_000);
  r.hub.push.prune(r.clock.now());
  await idle(30);
  assert.equal(r.pushed.length, before + 1);
  assert.equal(r.pushed.at(-1).activity.event, 'end');
  r.hub.push.prune(r.clock.now());
  await idle(10);
  assert.equal(r.pushed.length, before + 1);
});

test('a failed exit push on expiry is counted and does not throw out of the sweep', async () => {
  const r = await pairedOn(db, { send: async () => ({ ok: true }) });
  r.hub.push.store.activityTokenOf = async () => {
    throw new Error('db down');
  };
  r.hub.push.activities.set('ph1', P, parseSnapshot(snap())!, r.clock.now());
  r.clock.advance(31 * 60_000);
  r.hub.push.prune(r.clock.now());
  await idle(20);
  assert.ok(r.hub.push.metrics.render().includes('relay_activity_updates_total{status="failed"} 1'));
});

test('a dead activity token clears the baseline it set, and leaves the baseline of an earlier activity alone', async () => {
  const NEXT = 'cd'.repeat(32);
  let answer: any = { ok: true };
  const r = await pairedOn(db, { send: async () => answer });
  await r.phone.say({ t: 'activity.register', token: TOKEN });
  await r.mac.say({ t: 'activity', pair: P, state: snap({ needs: 2 }) });
  assert.equal(r.hub.push.lastNeeds.get('ph1')?.token, TOKEN);
  // the next activity's first update is refused: the baseline of the activity before it is not its to clear
  answer = { ok: false, invalidToken: true };
  await r.phone.say({ t: 'activity.register', token: NEXT });
  assert.equal(await r.store.activityTokenOf('ph1'), null);
  assert.equal(r.hub.push.lastNeeds.get('ph1')?.token, TOKEN);
  // the token that set the baseline going dead clears it
  answer = { ok: true };
  await r.phone.say({ t: 'activity.register', token: TOKEN });
  answer = { ok: false, invalidToken: true };
  await r.mac.say({ t: 'activity', pair: P, state: snap({ needs: 3 }) });
  assert.equal(r.hub.push.lastNeeds.has('ph1'), false);
});
