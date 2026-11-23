// relay/src/hub.mjs with fake sockets and a fake clock over a real Postgres: pairing, who may send what, live and mailbox delivery in order, token refresh and error handling.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeHub, settle, FakeSocket, P, b64, frame, paired as pairedOn } from './support/relayKit.ts';

const { db, reset } = await makeDb();
beforeEach(reset);
const paired = (o: Parameters<typeof makeHub>[1] = {}) => pairedOn(db, o);

test("hello: a device learns its pairs, its role and the Mac's presence", async () => {
  const r = makeHub(db);
  const mac = await r.join('u1', 'mac1', 'desktop');
  assert.deepEqual(mac.socket.of('hello')[0], { t: 'hello', device: 'mac1', kind: 'desktop', pairs: [], peerEvents: true });
  await mac.say({ t: 'pair.register', pair: P });
  const phone = await r.join('u1', 'ph1', 'phone');
  await phone.say({ t: 'pair.join', pair: P });
  assert.deepEqual(phone.socket.of('ok')[0], { t: 'ok', op: 'pair.join', pair: P, presence: 'online' });
  assert.deepEqual(mac.socket.events('pair.joined'), [{ t: 'event', ev: 'pair.joined', pair: P }]);
  const phone2 = await r.join('u1', 'ph1', 'phone');
  assert.deepEqual(phone2.socket.of('hello')[0].pairs, [{ pair: P, role: 'phone', joined: true, peerOnline: true, presence: 'online' }]);
  const mac2 = await r.join('u1', 'mac1', 'desktop');
  assert.deepEqual(mac2.socket.of('hello')[0].pairs, [{ pair: P, role: 'mac', joined: true, peerOnline: true }]);
  assert.deepEqual(r.logs.filter(([e]) => e === 'connect').length, 4);
});

test('a Mac hears each of its phones connect and leave; a replaced phone socket says nothing', async () => {
  const r = makeHub(db);
  const mac = await r.join('u1', 'mac1', 'desktop');
  await mac.say({ t: 'pair.register', pair: P });
  const phone = await r.join('u1', 'ph1', 'phone');
  await phone.say({ t: 'pair.join', pair: P });
  assert.deepEqual(phone.socket.of('hello')[0].peerEvents, undefined, 'only a Mac is told it gets peer events');
  const again = await r.join('u1', 'ph1', 'phone');
  assert.deepEqual(mac.socket.events('peer'), [{ t: 'event', ev: 'peer', pair: P, online: true }], 'the joined phone came back');
  // the first socket was replaced: its close is not the phone leaving
  phone.h.close(1000);
  await settle(r.hub);
  assert.equal(mac.socket.events('peer').length, 1);
  again.h.close(1000);
  await settle(r.hub);
  assert.deepEqual(mac.socket.events('peer').at(-1), { t: 'event', ev: 'peer', pair: P, online: false });
});

test('a revoked device is closed at connect; a second socket for a device replaces the first', async () => {
  const r = makeHub(db);
  await r.store.revokeDevice({ deviceId: 'gone', userId: 'u1', now: r.clock.t });
  const gone = await r.join('u1', 'gone', 'phone');
  assert.deepEqual(gone.socket.closedWith, { code: 4403, reason: 'revoked' });
  assert.equal(r.hub.conns.has('gone'), false);
  const a = await r.join('u1', 'mac1', 'desktop');
  const b = await r.join('u1', 'mac1', 'desktop');
  assert.deepEqual(a.socket.closedWith, { code: 4000, reason: 'replaced' });
  a.h.close(1000);
  await settle(r.hub);
  assert.equal(r.hub.conns.get('mac1')!.socket, b.socket);
  assert.equal(r.hub.presenceOf('mac1'), 'online');
});

test("pair.register is the Mac's: a phone is forbidden, a bad id is refused, a taken id says so", async () => {
  const r = makeHub(db);
  const mac = await r.join('u1', 'mac1', 'desktop');
  const phone = await r.join('u1', 'ph1', 'phone');
  await phone.say({ t: 'pair.register', pair: P, rid: 'r1' });
  assert.deepEqual(phone.socket.last(), { t: 'error', code: 'forbidden', rid: 'r1' });
  await mac.say({ t: 'pair.register', pair: 'x' });
  assert.equal(mac.socket.last().code, 'bad_message');
  await mac.say({ t: 'pair.register', pair: P, rid: 'r2' });
  assert.deepEqual(mac.socket.last(), { t: 'ok', op: 'pair.register', pair: P, rid: 'r2' });
  const other = await r.join('u2', 'mac9', 'desktop');
  await other.say({ t: 'pair.register', pair: P });
  assert.deepEqual(other.socket.last(), { t: 'error', code: 'pair_exists', pair: P });
});

test("pair.join is the phone's, on its own account, once", async () => {
  const r = makeHub(db);
  const mac = await r.join('u1', 'mac1', 'desktop');
  await mac.say({ t: 'pair.register', pair: P });
  await mac.say({ t: 'pair.join', pair: P });
  assert.equal(mac.socket.last().code, 'forbidden');
  const phone = await r.join('u1', 'ph1', 'phone');
  await phone.say({ t: 'pair.join', pair: 'bad' });
  assert.equal(phone.socket.last().code, 'bad_message');
  await phone.say({ t: 'pair.join', pair: 'p_nothing001' });
  assert.equal(phone.socket.last().code, 'unknown_pair');
  const stranger = await r.join('u2', 'ph9', 'phone');
  await stranger.say({ t: 'pair.join', pair: P });
  assert.equal(stranger.socket.last().code, 'forbidden');
  await phone.say({ t: 'pair.join', pair: P });
  const second = await r.join('u1', 'ph2', 'phone');
  await second.say({ t: 'pair.join', pair: P });
  assert.equal(second.socket.last().code, 'taken');
  // the Mac was offline at join time: no event, no crash
  mac.h.close(1000);
  await settle(r.hub);
  const late = await r.join('u1', 'ph1', 'phone');
  await late.say({ t: 'pair.join', pair: P });
  assert.equal(late.socket.last().presence, 'gone');
});

test('frames go live to an online peer and are acked "live"; the box arrives byte for byte', async () => {
  const { mac, phone } = await paired();
  await mac.say(frame('m2p', 1));
  assert.deepEqual(mac.socket.last(), { t: 'ack', pair: P, dir: 'm2p', ctr: 1, via: 'live' });
  assert.deepEqual(phone.socket.last(), frame('m2p', 1));
  await phone.say(frame('p2m', 1));
  assert.deepEqual(mac.socket.last(), frame('p2m', 1));
});

test('frames for an offline peer wait in the mailbox, acked "mailbox", and arrive in order when it connects', async () => {
  const r = await paired();
  r.phone.h.close(1001);
  await settle(r.hub);
  for (const ctr of [1, 2, 3]) await r.mac.say(frame('m2p', ctr));
  assert.deepEqual(
    r.mac.socket.of('ack').map((a) => [a.ctr, a.via]),
    [
      [1, 'mailbox'],
      [2, 'mailbox'],
      [3, 'mailbox'],
    ],
  );
  const back = await r.join('u1', 'ph1', 'phone');
  assert.deepEqual(
    back.socket.of('frame').map((f) => f.ctr),
    [1, 2, 3],
  );
  assert.deepEqual(await r.store.waiting(P, 'm2p', 10), []);
  // a phone-side frame while the Mac is gone waits for the Mac
  r.mac.h.close(1000);
  await settle(r.hub);
  await back.say(frame('p2m', 7));
  const mac = await r.join('u1', 'mac1', 'desktop');
  assert.deepEqual(
    mac.socket.of('frame').map((f) => f.ctr),
    [7],
  );
});

test('a long mailbox drains in batches, oldest first, and frames sent meanwhile queue behind it', async () => {
  const r = await paired({ mailbox: { ttlMs: 1e9, maxFrames: 500, maxBytes: 1e8 } });
  r.phone.h.close(1001);
  await settle(r.hub);
  for (let ctr = 1; ctr <= 120; ctr++) await r.mac.say(frame('m2p', ctr, { box: b64(10, 1) }));
  const sock = new FakeSocket();
  let injected = false;
  sock.onSend = (m) => {
    if (m.t === 'frame' && m.ctr === 3 && !injected) {
      injected = true;
      // while the drain runs, the Mac sends 121: it must not overtake 4..120
      r.mac.h.message(JSON.stringify(frame('m2p', 121, { box: b64(10, 1) })));
    }
  };
  const identity = { userId: 'u1', deviceId: 'ph1', kind: 'phone' as const, expMs: r.clock.t + 900_000 };
  r.hub.connect(sock as any, identity);
  await settle(r.hub);
  await settle(r.hub);
  assert.deepEqual(
    sock.of('frame').map((f) => f.ctr),
    Array.from({ length: 121 }, (_, i) => i + 1),
  );
  assert.equal(r.mac.socket.of('ack').find((a) => a.ctr === 121).via, 'mailbox');
  assert.deepEqual(await r.store.waiting(P, 'm2p', 10), []);
});

test('kick while draining marks it dirty and a closed connection is left alone', async () => {
  const r = await paired();
  const conn = r.hub.conns.get('ph1')!;
  conn.draining = true;
  await r.hub.kick(conn);
  assert.equal(conn.dirty, true);
  conn.draining = false;
  conn.closed = true;
  await r.hub.kick(conn);
  assert.equal(await r.hub.send(conn, { t: 'x' }), false);
});

test('a socket that fails mid-drain keeps the undelivered frames; one that throws or fails live gets the mailbox', async () => {
  const r = await paired();
  r.phone.h.close(1001);
  await settle(r.hub);
  for (const ctr of [1, 2, 3]) await r.mac.say(frame('m2p', ctr));
  const sock = new FakeSocket();
  sock.onSend = (m) => {
    if (m.t === 'frame' && m.ctr === 2) sock.failSend = true;
  };
  r.hub.connect(sock as any, { userId: 'u1', deviceId: 'ph1', kind: 'phone', expMs: r.clock.t + 900_000 });
  await settle(r.hub);
  assert.deepEqual(
    sock.of('frame').map((f) => f.ctr),
    [1, 2],
  );
  // frame 2 reached the fake but its callback said failed, so it stays; 3 was never tried
  assert.deepEqual(
    (await r.store.waiting(P, 'm2p', 10)).map((f) => f.ctr),
    [2, 3],
  );
  // a live send that fails falls back to the mailbox
  const live = await paired();
  live.phone.socket.failSend = true;
  await live.mac.say(frame('m2p', 1));
  assert.equal(live.mac.socket.last().via, 'mailbox');
  live.phone.socket.failSend = false;
  live.phone.socket.throwSend = true;
  await live.mac.say(frame('m2p', 2));
  assert.equal(live.mac.socket.last().via, 'mailbox');
});

test("a frame must be well-formed, on a joined pair the sender belongs to, in the sender's direction", async () => {
  const r = makeHub(db);
  const mac = await r.join('u1', 'mac1', 'desktop');
  await mac.say({ t: 'pair.register', pair: P });
  await mac.say(frame('m2p', 1));
  assert.equal(mac.socket.last().code, 'unknown_pair');
  const phone = await r.join('u1', 'ph1', 'phone');
  await phone.say({ t: 'pair.join', pair: P });
  await mac.say(frame('p2m', 1));
  assert.equal(mac.socket.last().code, 'bad_dir');
  await phone.say(frame('m2p', 1));
  assert.equal(phone.socket.last().code, 'bad_dir');
  await phone.say(frame('p2m', -1));
  assert.deepEqual(phone.socket.last(), { t: 'error', code: 'bad_frame', pair: P });
  const intruder = await r.join('u1', 'ph7', 'phone');
  await intruder.say(frame('p2m', 1));
  assert.equal(intruder.socket.last().code, 'unknown_pair');
  await intruder.say(frame('p2m', 1, { pair: 'p_nothing001' }));
  assert.equal(intruder.socket.last().code, 'unknown_pair');
});

test('a full mailbox tells the sender instead of dropping silently', async () => {
  const r = await paired();
  r.phone.h.close(1001);
  await settle(r.hub);
  const { MAILBOX } = await import('./support/relayKit.ts');
  for (let ctr = 0; ctr < MAILBOX.maxFrames; ctr++)
    await r.store.enqueue({
      pairId: P,
      dir: 'm2p',
      ctr,
      nonce: Buffer.alloc(24),
      box: Buffer.alloc(8),
      now: r.clock.t,
      ttlMs: 1e9,
      maxFrames: MAILBOX.maxFrames,
      maxBytes: MAILBOX.maxBytes,
    });
  await r.mac.say(frame('m2p', 999));
  assert.deepEqual(r.mac.socket.last(), { t: 'error', code: 'mailbox_full', pair: P, ctr: 999 });
});

test('unknown, malformed and non-text messages get bad_message with the request id echoed (cut to 64)', async () => {
  const r = makeHub(db);
  const mac = await r.join('u1', 'mac1', 'desktop');
  mac.h.message('not json');
  await settle(r.hub);
  assert.deepEqual(mac.socket.last(), { t: 'error', code: 'bad_message' });
  await mac.say({ t: 'nope', rid: 'x'.repeat(100) });
  assert.deepEqual(mac.socket.last(), { t: 'error', code: 'bad_message', rid: 'x'.repeat(64) });
  await mac.say({ t: 'nope', rid: 5 });
  assert.equal(mac.socket.last().rid, undefined);
});

test('auth refresh: the same device with a fresh token extends the socket; anything else closes it 4401', async () => {
  const r = makeHub(db);
  const mac = await r.join('u1', 'mac1', 'desktop');
  const fresh = { userId: 'u1', deviceId: 'mac1', kind: 'desktop' as const, expMs: r.clock.t + 5_000_000 };
  r.identities.set('fresh', fresh);
  await mac.say({ t: 'auth', token: 'fresh', rid: 'a' });
  assert.deepEqual(mac.socket.last(), { t: 'ok', op: 'auth', rid: 'a' });
  assert.equal(r.hub.conns.get('mac1')!.identity.expMs, fresh.expMs);
  for (const [i, bad] of [{ token: 7 }, { token: 'unknown' }, { token: 'other-device' }, { token: 'other-user' }].entries()) {
    const sock = await r.join('u1', `dev${i}`, 'desktop');
    r.identities.set('other-device', { ...fresh, deviceId: 'zzz' });
    r.identities.set('other-user', { ...fresh, deviceId: `dev${i}`, userId: 'u2' });
    await sock.say({ t: 'auth', ...bad });
    assert.deepEqual(sock.socket.closedWith, { code: 4401, reason: 'auth' }, JSON.stringify(bad));
    await sock.say({ t: 'presence', state: 'online' });
    assert.equal(sock.socket.last().t !== 'ok' || sock.socket.last().op !== 'presence', true);
  }
});
