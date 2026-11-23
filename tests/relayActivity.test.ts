// The Live Activity path on the relay: a phone registers the activity's token, a Mac sends a snapshot of counts (and optional sealed row labels), and the
// relay merges the pairs of one phone into one ActivityKit update that carries counts, a kind, a start time and rows only.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, paired as pairedOn, P, settle } from './support/relayKit.ts';
import { waitFor } from './support/waitFor.ts';
import { MAX_ROW_SEALED, STALE_MS, FINISHED_LINGER_MS, ActivityFeed, parseSnapshot } from '../relay/src/activity.mjs';
import { MAX_ROWS, MAX_COUNT, STATE_KINDS } from '../relay/src/activity.mjs';
import { apnsBody } from '../relay/src/pushPayload.mjs';
import { PushService } from '../relay/src/push.mjs';
import * as shared from '../shared/remote/activity.mjs';
import { TITLES } from '../relay/src/notifier.mjs';
import { proxySender } from '../relay/src/push.mjs';

const { db, reset } = await makeDb();
beforeEach(reset);
const paired = () => pairedOn(db, {});
const TOKEN = 'ab'.repeat(32);
const snap = (o: object = {}) => ({ needs: 1, running: 2, kind: 'needs', since: 1_900_000_000, at: 1_900_000_100, rows: [], ...o });

test('a phone registers and removes the activity token; a Mac may not; a malformed token is refused', async () => {
  const r = await paired();
  await r.mac.say({ t: 'activity.register', token: TOKEN });
  assert.equal(r.mac.socket.last().code, 'forbidden');
  await r.mac.say({ t: 'activity.unregister' });
  assert.equal(r.mac.socket.last().code, 'forbidden');
  for (const bad of [5, '', 'xyz', 'ab', 'g'.repeat(32), 'a'.repeat(513)]) {
    await r.phone.say({ t: 'activity.register', token: bad });
    assert.equal(r.phone.socket.last().code, 'bad_message');
  }
  await r.phone.say({ t: 'activity.register', token: TOKEN });
  assert.equal(r.phone.socket.last().op, 'activity.register');
  assert.equal(await r.store.activityTokenOf('ph1'), TOKEN);
  await r.phone.say({ t: 'activity.unregister' });
  assert.equal(await r.store.activityTokenOf('ph1'), null);
});

test('the activity token is independent of the alert token: either can be removed without the other', async () => {
  const r = await paired();
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'alert-tok' });
  await r.phone.say({ t: 'activity.register', token: TOKEN });
  await r.phone.say({ t: 'push.unregister' });
  assert.equal(await r.store.activityTokenOf('ph1'), TOKEN);
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'alert-tok' });
  await r.phone.say({ t: 'activity.unregister' });
  assert.deepEqual(await r.store.pushTokenOf('ph1'), { platform: 'apns', token: 'alert-tok' });
});

test('a Mac snapshot becomes one ActivityKit update with counts, a kind, a start time and rows, answered like a push request', async () => {
  const r = await paired();
  await r.phone.say({ t: 'activity.register', token: TOKEN });
  await r.mac.say({
    t: 'activity',
    pair: P,
    rid: 'a1',
    state: snap({ rows: [{ kind: 'needs', since: 1_900_000_050, ref: 'chat-1', st: 'SEALED' }] }),
  });
  assert.deepEqual(
    r.mac.socket.of('push.result').map((m) => [m.rid, m.status]),
    [['a1', 'sent']],
  );
  const m = r.pushed.at(-1);
  assert.equal(m.token, TOKEN);
  assert.equal(m.kind, 'activity');
  assert.equal(m.activity.event, 'update');
  assert.deepEqual(m.activity.state, {
    needs: 1,
    running: 2,
    kind: 'needs',
    since: 1_900_000_000,
    rows: [{ kind: 'needs', since: 1_900_000_050, ref: 'chat-1', st: 'SEALED' }],
  });
  assert.equal(m.activity.staleAt - m.activity.timestamp, STALE_MS / 1000);
  assert.equal(m.activity.priority, 10);
});

test('a field the relay does not know is ignored, and a malformed known field is refused', async () => {
  const r = await paired();
  await r.phone.say({ t: 'activity.register', token: TOKEN });
  const extra = {
    ...snap({ rows: [{ kind: 'running', since: 5, ref: 'c', diff: '+80 -230', command: 'rm -rf', file: 'a.ts', plan: 'secret' }] }),
    title: 'Clean up',
    diffStats: '+80',
    nested: { a: 1 },
  };
  await r.mac.say({ t: 'activity', pair: P, extra: 'x', state: extra });
  const wire = JSON.stringify(r.pushed.at(-1).activity.state);
  for (const leak of ['+80', 'rm -rf', 'a.ts', 'secret', 'Clean up', 'nested', 'extra']) assert.ok(!wire.includes(leak), leak);
  assert.deepEqual(Object.keys(r.pushed.at(-1).activity.state).sort(), ['kind', 'needs', 'rows', 'running', 'since']);
  assert.deepEqual(Object.keys(r.pushed.at(-1).activity.state.rows[0]).sort(), ['kind', 'ref', 'since']);
  const before = r.pushed.length;
  for (const bad of [
    null,
    5,
    snap({ needs: -1 }),
    snap({ needs: 1.5 }),
    snap({ kind: 'failed' }),
    snap({ since: 'now' }),
    snap({ at: undefined }),
    snap({ rows: 'x' }),
    snap({ rows: new Array(4).fill({ kind: 'running', since: 1, ref: 'c' }) }),
    snap({ rows: [{ kind: 'x', since: 1, ref: 'c' }] }),
    snap({ rows: [{ kind: 'running', since: 1, ref: '' }] }),
    snap({ rows: [{ kind: 'running', since: 1, ref: 'c'.repeat(129) }] }),
    snap({ rows: [{ kind: 'running', since: 1, ref: 'c', st: 'S'.repeat(MAX_ROW_SEALED + 1) }] }),
    snap({ rows: [{ kind: 'running', since: 1, ref: 'c', st: 5 }] }),
    snap({ rows: [null] }),
    snap({ rows: [{ kind: 'running', since: 1, ref: 'a b' }] }),
    snap({ rows: [{ kind: 'running', since: 1, ref: 'chät' }] }),
    snap({ rows: [{ kind: 'running', since: 1, ref: 'c', st: 'not base64!' }] }),
    snap({ rows: [{ kind: 'running', since: 1, ref: 'c', st: 'a=' }] }),
  ]) {
    await r.mac.say({ t: 'activity', pair: P, state: bad });
    assert.equal(r.mac.socket.last().code, 'bad_message');
  }
  assert.equal(r.pushed.length, before);
  assert.equal(parseSnapshot(snap({ rows: undefined }))?.rows.length, 0);
});

test('only the paired Mac of a joined pair may send, and without a token nothing goes out', async () => {
  const r = await paired();
  await r.phone.say({ t: 'activity', pair: P, state: snap() });
  assert.equal(r.phone.socket.last().code, 'forbidden');
  await r.mac.say({ t: 'activity', pair: 'p_nopair0001', state: snap() });
  assert.equal(r.mac.socket.last().code, 'unknown_pair');
  await r.mac.say({ t: 'activity', pair: 5, state: snap() });
  assert.equal(r.mac.socket.last().code, 'unknown_pair');
  // a pair another Mac registered, and one whose phone has not joined yet
  const other = await r.join('u1', 'mac2', 'desktop');
  await other.say({ t: 'activity', pair: P, state: snap() });
  assert.equal(other.socket.last().code, 'unknown_pair');
  await other.say({ t: 'pair.register', pair: 'p_waiting001' });
  await other.say({ t: 'activity', pair: 'p_waiting001', state: snap() });
  assert.equal(other.socket.last().code, 'unknown_pair');
  await r.mac.say({ t: 'activity', pair: P, rid: 'n1', state: snap() });
  assert.equal(r.mac.socket.of('push.result').at(-1).status, 'no_token');
  assert.equal(r.pushed.length, 0);
});

test('registering the token sends the state already held, so a freshly started activity is not empty', async () => {
  const r = await paired();
  await r.mac.say({ t: 'activity', pair: P, state: snap({ needs: 0, running: 3, kind: 'running' }) });
  assert.equal(r.pushed.length, 0);
  await r.phone.say({ t: 'activity.register', token: TOKEN });
  assert.equal(r.pushed.length, 1);
  assert.equal(r.pushed[0].activity.state.running, 3);
});

test('counts add up across pairs and cap, the newest event names the kind, the earliest start leads, and the three most urgent rows show', () => {
  const feed = new ActivityFeed();
  const a = parseSnapshot(
    snap({
      needs: 60,
      running: 1,
      kind: 'running',
      since: 300,
      at: 10,
      rows: [
        { kind: 'running', since: 100, ref: 'a1' },
        { kind: 'done', since: 50, ref: 'a2' },
      ],
    }),
  )!;
  const b = parseSnapshot(
    snap({
      needs: 50,
      running: 2,
      kind: 'needs',
      since: 200,
      at: 20,
      rows: [
        { kind: 'needs', since: 400, ref: 'b1' },
        { kind: 'needs', since: 150, ref: 'b2' },
      ],
    }),
  )!;
  feed.set('ph', 'pa', a, 1000);
  feed.set('ph', 'pb', b, 1000);
  // an older snapshot does not take the kind from a newer one, whichever comes first
  feed.set('ph', 'pc', parseSnapshot(snap({ needs: 0, running: 0, kind: 'done', since: 0, at: 5 }))!, 1000);
  assert.deepEqual(feed.merged('ph', 1000), {
    needs: 99,
    running: 3,
    kind: 'needs',
    since: 200,
    rows: [
      { kind: 'needs', since: 150, ref: 'b2' },
      { kind: 'needs', since: 400, ref: 'b1' },
      { kind: 'running', since: 100, ref: 'a1' },
    ],
  });
  const none = parseSnapshot(snap({ needs: 0, running: 0, kind: 'done', since: 0 }))!;
  feed.set('ph2', 'pc', none, 1000);
  assert.equal(feed.merged('ph2', 1000)!.since, 0);
  assert.equal(feed.merged('nobody', 1000), null);
});

test('a snapshot nobody refreshed stops counting, and a removed pair is forgotten', () => {
  const feed = new ActivityFeed();
  feed.set('ph', 'pa', parseSnapshot(snap())!, 0);
  feed.set('ph', 'pb', parseSnapshot(snap())!, 25 * 60_000);
  assert.equal(feed.merged('ph', 31 * 60_000)!.needs, 1);
  feed.prune(31 * 60_000);
  assert.equal(feed.byPhone.get('ph')!.size, 1);
  // every snapshot of a phone expired: the phone is forgotten too
  feed.prune(60 * 60_000);
  assert.equal(feed.byPhone.size, 0);
  feed.set('ph', 'pb', parseSnapshot(snap())!, 0);
  feed.forgetPair('pb');
  assert.equal(feed.byPhone.size, 0);
});

test('nothing running or waiting ends the activity; a finished frame lingers, anything else goes at once', async () => {
  const r = await paired();
  await r.phone.say({ t: 'activity.register', token: TOKEN });
  await r.mac.say({ t: 'activity', pair: P, state: snap({ needs: 0, running: 0, kind: 'done', since: 0 }) });
  const done = r.pushed.at(-1).activity;
  assert.equal(done.event, 'end');
  assert.equal(done.dismissAt - done.timestamp, FINISHED_LINGER_MS / 1000);
  await r.mac.say({ t: 'activity', pair: P, state: snap({ needs: 0, running: 0, kind: 'running', since: 0 }) });
  const gone = r.pushed.at(-1).activity;
  assert.equal(gone.event, 'end');
  assert.equal(gone.dismissAt, gone.timestamp);
});

test('only a rise in "needs you" is sent at high priority; a failed send does not move the baseline', async () => {
  const fail = { on: false };
  const r = await pairedOn(db, { send: async (m: any) => (fail.on ? { ok: false } : (r.pushed.push(m), { ok: true })) });
  await r.phone.say({ t: 'activity.register', token: TOKEN });
  const prio = () => r.pushed.at(-1).activity.priority;
  await r.mac.say({ t: 'activity', pair: P, state: snap({ needs: 0, running: 1, kind: 'running' }) });
  assert.equal(prio(), 5);
  fail.on = true;
  await r.mac.say({ t: 'activity', pair: P, rid: 'f', state: snap({ needs: 2 }) });
  assert.equal(r.mac.socket.of('push.result').at(-1).status, 'failed');
  fail.on = false;
  await r.mac.say({ t: 'activity', pair: P, state: snap({ needs: 2 }) });
  assert.equal(prio(), 10);
  await r.mac.say({ t: 'activity', pair: P, state: snap({ needs: 2, running: 5 }) });
  assert.equal(prio(), 5);
});

test('a dead activity token is dropped without touching the alert token, and a failed send keeps it', async () => {
  let result: any = { ok: false, invalidToken: true };
  const r = await pairedOn(db, { send: async () => result });
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'alert-tok' });
  await r.phone.say({ t: 'activity.register', token: TOKEN });
  result = { ok: false };
  await r.mac.say({ t: 'activity', pair: P, state: snap() });
  assert.equal(await r.store.activityTokenOf('ph1'), TOKEN);
  result = { ok: false, invalidToken: true };
  await r.mac.say({ t: 'activity', pair: P, rid: 'd', state: snap() });
  assert.equal(r.mac.socket.of('push.result').at(-1).status, 'failed');
  assert.equal(await r.store.activityTokenOf('ph1'), null);
  assert.deepEqual(await r.store.pushTokenOf('ph1'), { platform: 'apns', token: 'alert-tok' });
});

test('updates for one phone go out one at a time and the newest state wins', async () => {
  const gate: (() => void)[] = [];
  const sent: any[] = [];
  const r = await pairedOn(db, {
    send: (m: any) => new Promise((resolve) => (sent.push(m), gate.push(() => resolve({ ok: true })))),
  });
  await r.phone.say({ t: 'activity.register', token: TOKEN });
  // `say` waits for the hub's tracked work, which is the held send: the messages are fired without waiting
  const fire = (needs: number) => r.mac.h.message(JSON.stringify({ t: 'activity', pair: P, state: snap({ needs }) }));
  fire(1);
  await waitFor(() => gate.length === 1, 'the first activity reaching its provider');
  fire(2);
  await r.hub.conns.get('mac1')!.queue;
  fire(3);
  await r.hub.conns.get('mac1')!.queue;
  assert.equal(sent.length, 1);
  gate.shift()!();
  await waitFor(() => sent.length === 2, 'the coalesced activity reaching its provider');
  assert.equal(sent.length, 2);
  gate.shift()!();
  await settle(r.hub);
  assert.deepEqual(
    sent.map((m) => m.activity.state.needs),
    [1, 3],
  );
  assert.deepEqual(
    r.mac.socket.of('push.result').map((m) => m.status),
    ['sent', 'sent', 'sent'],
  );
});

test('pair removal forgets the snapshot, and a phone left with no pair loses its activity token; revocation does too', async () => {
  const r = await paired();
  await r.phone.say({ t: 'activity.register', token: TOKEN });
  await r.mac.say({ t: 'activity', pair: P, state: snap() });
  assert.ok(r.hub.push.activities.merged('ph1', r.clock.now()));
  await r.mac.say({ t: 'pair.remove', pair: P });
  assert.equal(r.hub.push.activities.merged('ph1', r.clock.now()), null);
  assert.equal(await r.store.activityTokenOf('ph1'), null);
  const q = await paired();
  await q.phone.say({ t: 'activity.register', token: TOKEN });
  await q.hub.revoke({ userId: 'u1', deviceId: 'ph1' });
  assert.equal(await q.store.activityTokenOf('ph1'), null);
});

test('with push off or through the push proxy no activity update is sent', async () => {
  const off = new PushService({ store: {} as any, send: null });
  assert.equal(await off.activity({ pairId: 'p', phoneDeviceId: 'x' }, parseSnapshot(snap())!), 'disabled');
  const proxy = proxySender({
    url: 'http://proxy.invalid',
    fetch: (async () => {
      throw new Error('must not call');
    }) as any,
  });
  assert.deepEqual(
    await proxy({
      platform: 'apns',
      token: 't',
      kind: 'activity',
      title: '',
      count: 0,
      collapseId: '',
      ref: '',
      activity: { timestamp: 1, event: 'update', state: {}, staleAt: 2, dismissAt: 1, priority: 5 },
    }),
    { ok: false },
  );
});

test("the relay's limits and the fixed texts equal the shared names the Mac, the phone and the widget use", () => {
  assert.deepEqual([...shared.ACTIVITY_KINDS], STATE_KINDS);
  assert.equal(shared.ACTIVITY_MAX_ROWS, MAX_ROWS);
  assert.equal(shared.ACTIVITY_MAX_COUNT, MAX_COUNT);
  assert.equal(shared.ACTIVITY_MAX_ROW_SEALED, MAX_ROW_SEALED);
  // the rows read as the fixed push titles do
  assert.deepEqual({ ...shared.ACTIVITY_FIXED_TEXT }, { needs: TITLES.needsYou, running: 'A chat is running', done: TITLES.done });
  assert.deepEqual(
    [shared.ACTIVITY_REGISTER, shared.ACTIVITY_UNREGISTER, shared.ACTIVITY_UPDATE],
    ['activity.register', 'activity.unregister', 'activity'],
  );
});

test('three rows of the longest handle and sealed label stay under the 4 KB APNs limit', () => {
  const row = (kind: string) => ({ kind, since: 1_900_000_000, ref: 'r'.repeat(128), st: 'S'.repeat(MAX_ROW_SEALED) });
  const rows = [row('needs'), row('running'), row('done')];
  const state = parseSnapshot(snap({ needs: 99, running: 99, rows }))!;
  assert.equal(state.rows.length, 3);
  const body = apnsBody({
    activity: { timestamp: 1_900_000_000, event: 'update', state, staleAt: 1_900_001_200, dismissAt: 0, priority: 10 },
  } as any);
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < 4096);
});
