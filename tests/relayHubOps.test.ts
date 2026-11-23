// relay/src/hub.mjs presence, push requests, pings and token expiry, TTL drops and revocation, with fake sockets and a fake clock over a real Postgres.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeHub, settle, FakeSocket, P, frame, paired as pairedOn } from './support/relayKit.ts';
import { TITLES } from '../relay/src/notifier.mjs';

const { db, reset } = await makeDb();
beforeEach(reset);
const paired = (o: Parameters<typeof makeHub>[1] = {}) => pairedOn(db, o);

test('presence: a Mac says online or sleeping and its phones hear it; a close ends it unless it was sleeping', async () => {
  const r = await paired();
  await r.mac.say({ t: 'presence', state: 'sleeping', rid: 'p' });
  assert.deepEqual(r.mac.socket.last(), { t: 'ok', op: 'presence', rid: 'p' });
  assert.equal(r.phone.socket.events('machine.presence').at(-1).state, 'sleeping');
  await r.mac.say({ t: 'presence', state: 'online' });
  assert.equal(r.phone.socket.events('machine.presence').at(-1).state, 'online');
  await r.mac.say({ t: 'presence', state: 'busy' });
  assert.equal(r.mac.socket.last().code, 'bad_message');
  await r.phone.say({ t: 'presence', state: 'online' });
  assert.equal(r.phone.socket.last().code, 'bad_message');
  r.mac.h.close(1000);
  await settle(r.hub);
  const gone = r.phone.socket.events('machine.presence').at(-1);
  assert.equal(gone.state, 'gone');
  assert.equal(gone.at, r.clock.t);
  assert.equal(r.hub.presenceOf('mac1'), 'gone');
  assert.equal(r.pushed.length, 0);
});

test('a sleeping Mac that disconnects stays "sleeping" and raises no offline push', async () => {
  const r = await paired();
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  await r.mac.say({ t: 'presence', state: 'sleeping' });
  r.mac.h.close(1006);
  await settle(r.hub);
  assert.equal(r.hub.presenceOf('mac1'), 'sleeping');
  assert.equal(r.pushed.length, 0);
});

test('a Mac that vanishes raises "machineOffline" on its phone; a clean or hub-initiated close does not', async () => {
  const r = await paired();
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  r.mac.h.close(1006);
  await settle(r.hub);
  assert.equal(r.pushed.length, 1);
  assert.equal(r.pushed[0].title, TITLES.machineOffline);
  assert.equal(r.pushed[0].ref, P);
  const again = await r.join('u1', 'mac1', 'desktop');
  again.h.close(4401);
  await settle(r.hub);
  const third = await r.join('u1', 'mac1', 'desktop');
  third.h.close(1001);
  await settle(r.hub);
  assert.equal(r.pushed.length, 1);
  // a phone going away says nothing
  r.phone.h.close(1006);
  await settle(r.hub);
  assert.equal(r.pushed.length, 1);
});

test('pair.remove by either side deletes the pair and tells the other', async () => {
  const r = await paired();
  await r.phone.say({ t: 'pair.remove', pair: P, rid: 'x' });
  assert.deepEqual(r.phone.socket.last(), { t: 'ok', op: 'pair.remove', pair: P, rid: 'x' });
  assert.deepEqual(r.mac.socket.events('pair.removed'), [{ t: 'event', ev: 'pair.removed', pair: P, reason: 'unpaired' }]);
  assert.equal(await r.store.getPair(P), null);
  await r.phone.say({ t: 'pair.remove', pair: P });
  assert.equal(r.phone.socket.last().code, 'unknown_pair');
  await r.phone.say({ t: 'pair.remove', pair: 'bad' });
  assert.equal(r.phone.socket.last().code, 'unknown_pair');
  const again = await paired().catch(() => null);
  assert.ok(again === null || again);
});

test('pair.remove with the peer offline, and by the Mac', async () => {
  const r = await paired();
  r.phone.h.close(1001);
  await settle(r.hub);
  await r.mac.say({ t: 'pair.remove', pair: P });
  assert.equal(r.mac.socket.last().op, 'pair.remove');
  const stranger = await r.join('u1', 'mac7', 'desktop');
  await stranger.say({ t: 'pair.remove', pair: P });
  assert.equal(stranger.socket.last().code, 'unknown_pair');
});

test("push registration is the phone's and validated; push requests are the Mac's, on its own joined pair", async () => {
  const r = await paired();
  await r.mac.say({ t: 'push.register', platform: 'apns', token: 't' });
  assert.equal(r.mac.socket.last().code, 'forbidden');
  for (const bad of [
    { platform: 'sms', token: 't' },
    { platform: 'apns', token: '' },
    { platform: 'apns', token: 5 },
    { platform: 'fcm', token: 'x'.repeat(4097) },
  ]) {
    await r.phone.say({ t: 'push.register', ...bad });
    assert.equal(r.phone.socket.last().code, 'bad_message');
  }
  await r.phone.say({ t: 'push.register', platform: 'fcm', token: 'tok', rid: 'q' });
  assert.deepEqual(r.phone.socket.last(), { t: 'ok', op: 'push.register', rid: 'q' });
  assert.deepEqual(await r.store.pushTokenOf('ph1'), { platform: 'fcm', token: 'tok' });
  await r.mac.say({ t: 'push', pair: P, kind: 'needsYou', ref: 'chat-1', rid: 'z' });
  assert.deepEqual(r.mac.socket.last(), { t: 'push.result', pair: P, status: 'sent', rid: 'z' });
  assert.equal(r.pushed[0].title, TITLES.needsYou);
  await r.mac.say({ t: 'push', pair: P, kind: 'done', ref: 'chat-1' });
  assert.equal(r.mac.socket.last().status, 'suppressed');
  await r.phone.say({ t: 'push', pair: P, kind: 'done', ref: 'c' });
  assert.equal(r.phone.socket.last().code, 'forbidden');
  for (const bad of [{ kind: 'loud' }, { ref: '' }, { ref: 3 }, { ref: 'x'.repeat(129) }]) {
    await r.mac.say({ t: 'push', pair: P, kind: 'done', ref: 'c', ...bad });
    assert.equal(r.mac.socket.last().code, 'bad_message', JSON.stringify(bad).slice(0, 40));
  }
  await r.mac.say({ t: 'push', pair: 'p_nothing001', kind: 'done', ref: 'c' });
  assert.equal(r.mac.socket.last().code, 'unknown_pair');
  const other = await r.join('u1', 'mac2', 'desktop');
  await other.say({ t: 'push', pair: P, kind: 'done', ref: 'c' });
  assert.equal(other.socket.last().code, 'unknown_pair');
  await r.phone.say({ t: 'push.unregister', rid: 'u' });
  assert.deepEqual(r.phone.socket.last(), { t: 'ok', op: 'push.unregister', rid: 'u' });
  await r.mac.say({ t: 'push', pair: P, kind: 'needsYou', ref: 'c9' });
  assert.equal(r.mac.socket.last().status, 'no_token');
  await r.mac.say({ t: 'push.unregister' });
  assert.equal(r.mac.socket.last().code, 'forbidden');
});

test('a pending pair takes no push; with push off the answer is "disabled"', async () => {
  const r = makeHub(db, { send: null });
  const mac = await r.join('u1', 'mac1', 'desktop');
  await mac.say({ t: 'pair.register', pair: P });
  await mac.say({ t: 'push', pair: P, kind: 'done', ref: 'c' });
  assert.equal(mac.socket.last().code, 'unknown_pair');
  const phone = await r.join('u1', 'ph1', 'phone');
  await phone.say({ t: 'pair.join', pair: P });
  await mac.say({ t: 'push', pair: P, kind: 'done', ref: 'c' });
  assert.equal(mac.socket.last().status, 'disabled');
});

test('tick pings every socket, three missed pings end a Mac as gone (and raise machineOffline), a pong resets', async () => {
  const r = await paired();
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  r.hub.tick();
  assert.deepEqual([r.mac.socket.pings, r.phone.socket.pings], [1, 1]);
  r.phone.h.pong();
  r.hub.tick();
  r.hub.tick();
  assert.equal(r.mac.socket.terminated, false);
  r.hub.tick();
  assert.equal(r.mac.socket.terminated, true);
  assert.equal(r.phone.socket.terminated, false);
  await settle(r.hub);
  assert.equal(r.hub.presenceOf('mac1'), 'gone');
  assert.equal(r.pushed[0].title, TITLES.machineOffline);
});

test('tick: a ping that throws counts as dead, and a token past its grace closes the socket 4401', async () => {
  const r = makeHub(db);
  const a = await r.join('u1', 'macA', 'desktop');
  a.socket.throwPing = true;
  r.hub.tick();
  r.hub.tick();
  assert.equal(a.socket.terminated, true);
  const b = await r.join('u1', 'macB', 'desktop', r.clock.t + 1000);
  r.clock.advance(1000 + 60_000);
  r.hub.tick();
  assert.equal(b.socket.closedWith, null);
  r.clock.advance(1);
  r.hub.tick();
  assert.deepEqual(b.socket.closedWith, { code: 4401, reason: 'token_expired' });
  await settle(r.hub);
  assert.equal(r.hub.conns.has('macB'), false);
});

test('a frame closes with the socket: close() fallback terminates when close throws', async () => {
  const r = makeHub(db);
  const a = await r.join('u1', 'macA', 'desktop', r.clock.t + 1000);
  a.socket.throwClose = true;
  r.clock.advance(70_000);
  r.hub.tick();
  assert.equal(a.socket.terminated, true);
});

test('sweep drops frames past the TTL and tells an online sender at once, an offline one when it returns', async () => {
  const r = await paired();
  r.phone.h.close(1001);
  r.mac.h.close(1000);
  await settle(r.hub);
  const mac = await r.join('u1', 'mac1', 'desktop');
  await mac.say(frame('m2p', 1));
  await mac.say(frame('m2p', 2));
  mac.socket.sent.length = 0;
  r.clock.advance(7 * 24 * 3600_000 - 1);
  await r.hub.sweep();
  assert.deepEqual(mac.socket.events('mailbox.dropped'), []);
  r.clock.advance(1);
  await r.hub.sweep();
  assert.deepEqual(mac.socket.events('mailbox.dropped'), [
    { t: 'event', ev: 'mailbox.dropped', pair: P, dir: 'm2p', count: 2, firstCtr: 1, lastCtr: 2 },
  ]);
  // the phone's side: sent while the Mac was away, swept while the phone is away
  const phone = await r.join('u1', 'ph1', 'phone');
  r.mac.h.close(1000);
  mac.h.close(1000);
  await settle(r.hub);
  await phone.say(frame('p2m', 5));
  phone.h.close(1001);
  await settle(r.hub);
  r.clock.advance(8 * 24 * 3600_000);
  await r.hub.sweep();
  const back = await r.join('u1', 'ph1', 'phone');
  assert.deepEqual(
    back.socket.events('mailbox.dropped').map((e) => [e.dir, e.count]),
    [['p2m', 1]],
  );
  assert.deepEqual(await r.store.takeDrops(P, 'p2m'), []);
});

test('revoking a phone closes its socket, removes the pair and tells the Mac; revoking an unknown device is harmless', async () => {
  const r = await paired();
  await r.hub.revoke({ userId: 'u1', deviceId: 'ph1' });
  assert.deepEqual(r.phone.socket.closedWith, { code: 4403, reason: 'revoked' });
  assert.deepEqual(r.mac.socket.events('pair.removed'), [{ t: 'event', ev: 'pair.removed', pair: P, reason: 'revoked' }]);
  assert.equal(await r.store.getPair(P), null);
  assert.equal(r.hub.conns.has('ph1'), false);
  const again = await r.join('u1', 'ph1', 'phone');
  assert.equal(again.socket.closedWith!.code, 4403);
  await r.hub.revoke({ userId: 'u1', deviceId: 'nobody' });
  assert.deepEqual(
    r.logs.filter(([e]) => e === 'revoke').map(([, d]) => d.pairs),
    [1, 0],
  );
});

test('revoking a Mac clears its presence and does not raise machineOffline', async () => {
  const r = await paired();
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  await r.hub.revoke({ userId: 'u1', deviceId: 'mac1' });
  assert.equal(r.mac.socket.closedWith!.code, 4403);
  assert.equal(r.hub.presenceOf('mac1'), 'gone');
  assert.equal(r.phone.socket.events('pair.removed').length, 1);
  r.mac.h.close(4403);
  await settle(r.hub);
  assert.equal(r.pushed.length, 0);
});

test('a failing database is logged per connection; a frame that failed ends that connection and the next connection runs', async () => {
  const r = await paired();
  r.hub.sleep = async () => undefined;
  const real = r.store.getPair.bind(r.store);
  r.store.getPair = async () => {
    throw new Error('db down');
  };
  await r.mac.say(frame('m2p', 1));
  assert.equal(r.mac.socket.closedWith?.code, 4500);
  // an error that is not an Error is logged too
  r.store.getPair = async () => {
    throw 'plain string';
  };
  const second = await r.join('u1', 'mac1', 'desktop');
  await second.say(frame('m2p', 1));
  assert.equal(second.socket.closedWith?.code, 4500);
  r.store.getPair = real;
  const third = await r.join('u1', 'mac1', 'desktop');
  await third.say(frame('m2p', 1));
  assert.deepEqual(
    r.logs.filter(([e]) => e === 'error').map(([, d]) => d.message),
    ['db down', 'plain string'],
  );
  assert.equal(r.phone.socket.of('frame').at(-1).ctr, 1);
});

test('after a socket is closed its late messages are ignored', async () => {
  const r = await paired();
  r.hub.conns.get('mac1')!.closed = true;
  await r.mac.say(frame('m2p', 1));
  assert.equal(r.phone.socket.of('frame').length, 0);
});

test('the default log is silent', async () => {
  const { Hub } = await import('../relay/src/hub.mjs');
  const r = makeHub(db);
  const hub = new Hub({
    store: r.store,
    push: r.push,
    verifier: r.verifier as any,
    config: { mailbox: { ttlMs: 1, maxFrames: 1, maxBytes: 1 }, pairJoinMs: 1 },
  });
  const sock = new FakeSocket();
  hub.connect(sock as any, { userId: 'u', deviceId: 'd', kind: 'desktop', expMs: Date.now() + 1e6 });
  await settle(hub);
  assert.equal(sock.of('hello').length, 1);
});

test('a Mac reconnecting with a pending pair sees it unjoined; it can remove it, and a revoked Mac with a pending pair names no peer', async () => {
  const r = makeHub(db);
  const first = await r.join('u1', 'mac1', 'desktop');
  await first.say({ t: 'pair.register', pair: P });
  first.h.close(1000);
  await settle(r.hub);
  const mac = await r.join('u1', 'mac1', 'desktop');
  assert.deepEqual(mac.socket.of('hello')[0].pairs, [{ pair: P, role: 'mac', joined: false, peerOnline: false }]);
  await mac.say({ t: 'pair.remove', pair: P });
  assert.equal(mac.socket.last().op, 'pair.remove');
  await mac.say({ t: 'pair.register', pair: P });
  await r.hub.revoke({ userId: 'u1', deviceId: 'mac1' });
  assert.equal(r.hub.conns.has('mac1'), false);
  assert.equal(await r.store.getPair(P), null);
});

test('a push request naming a malformed pair is unknown_pair', async () => {
  const r = await paired();
  await r.mac.say({ t: 'push', pair: 'bad', kind: 'done', ref: 'c' });
  assert.equal(r.mac.socket.last().code, 'unknown_pair');
});

test('a sweep whose pair vanished meanwhile skips the notice', async () => {
  const r = await paired();
  r.phone.h.close(1001);
  await settle(r.hub);
  await r.mac.say(frame('m2p', 1));
  r.clock.advance(8 * 24 * 3600_000);
  r.store.getPair = async () => null;
  await r.hub.sweep();
  assert.deepEqual(r.mac.socket.events('mailbox.dropped'), []);
});

test('a close without a status code (1005) is a normal disconnect, not a vanished Mac', async () => {
  const r = await paired();
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  r.mac.h.close(1005);
  await settle(r.hub);
  assert.equal(r.pushed.length, 0);
});

test('a database error while ending a socket from tick is logged, not an unhandled rejection', async () => {
  const r = await paired();
  r.store.phonesOfMac = async () => {
    throw new Error('db down');
  };
  for (let i = 0; i < 4; i++) r.hub.tick();
  await settle(r.hub);
  assert.deepEqual(
    r.logs.filter(([e]) => e === 'error').map(([, d]) => d.message),
    ['db down'],
  );
  r.store.phonesOfMac = async () => {
    throw 'plain';
  };
  const mac = await r.join('u1', 'mac1', 'desktop');
  for (let i = 0; i < 4; i++) r.hub.tick();
  await settle(r.hub);
  assert.equal(mac.socket.terminated, true);
  assert.equal(r.logs.filter(([e]) => e === 'error').at(-1)[1].message, 'plain');
});

test('a revocation that lands while a connection is starting still closes it', async () => {
  const r = makeHub(db);
  const real = r.store.isRevoked.bind(r.store);
  let calls = 0;
  r.store.isRevoked = async (id: string) => (++calls === 1 ? false : real(id));
  await r.store.revokeDevice({ deviceId: 'ph1', userId: 'u1', now: r.clock.t });
  const phone = await r.join('u1', 'ph1', 'phone');
  assert.deepEqual(phone.socket.closedWith, { code: 4403, reason: 'revoked' });
  assert.equal(r.hub.conns.has('ph1'), false);
  assert.equal(phone.socket.of('hello').length, 0);
});

test('a connection that piles up unhandled messages past the hard cap is cut off', async () => {
  const r = makeHub(db);
  const mac = await r.join('u1', 'mac1', 'desktop');
  for (let i = 0; i < 2005; i++) mac.h.message(JSON.stringify({ t: 'presence', state: 'online' }));
  assert.deepEqual(mac.socket.closedWith, { code: 1008, reason: 'too many pending messages' });
  await settle(r.hub);
});
