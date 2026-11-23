// Hosts on the relay (#2709): the host lane registers and revokes a Host's credential, frames between the lane and its Host are
// live only (never stored, `peer_offline` when the other end is away), each end hears the other come and go, the Host cap, the
// device revocation and the account purge take Host credentials with them, and the server verifies `mh1` tokens with a per-address limit.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { loadConfig } from '../relay/src/config.mjs';
import { createVerifier } from '../relay/src/auth.mjs';
import { createRelay } from '../relay/src/server.mjs';
import { purgeAccount, digestOf } from '../relay/src/purge.mjs';
import { laneOf, refreshed, revocableId, verifyHost } from '../relay/src/hosts.mjs';
import { tickHub } from '../relay/src/liveness.mjs';
import { b64, makeDb, makeHub, makeKeys, FakeSocket } from './support/relayKit.ts';

const { db, reset } = await makeDb();
const HOST = 'h_host0000000000001';
const HOST2 = 'h_host0000000000002';
const PAIR = 'p_hostpair01';
const SECRET = 'A'.repeat(43);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const lane = (did = 'mac1') => laneOf({ userId: 'u1', deviceId: did, kind: 'desktop', expMs: Date.UTC(2031, 0, 1) });
const hostIdentity = (id = HOST, userId = 'u1') => ({ userId, deviceId: id, kind: 'host', expMs: Number.MAX_SAFE_INTEGER });
const hf = (dir: 'm2p' | 'p2m', ctr: number, pair = PAIR) => ({ t: 'frame', pair, dir, ctr, nonce: b64(24), box: b64(40, ctr) });

async function rig(limits: object = {}) {
  await reset();
  const r = makeHub(db, { limits });
  const connect = async (identity: any) => {
    const socket = new FakeSocket();
    const h = r.hub.connect(socket as any, identity);
    const { settle } = await import('./support/relayKit.ts');
    await settle(r.hub);
    const say = async (m: object) => {
      h.message(JSON.stringify(m));
      await settle(r.hub);
    };
    return { socket, h, say };
  };
  return { ...r, connect };
}

test('identities: the lane has its own id and refreshes as itself; a Host never refreshes', () => {
  const l = lane();
  assert.equal(l.deviceId, 'mac1~h');
  assert.equal(l.kind, 'hostlink');
  assert.equal(revocableId(l), 'mac1');
  assert.equal(revocableId(hostIdentity() as any), HOST);
  const next = { userId: 'u1', deviceId: 'mac1', kind: 'desktop' as const, expMs: 5 };
  assert.equal(refreshed(l as any, next)?.expMs, 5);
  assert.equal(refreshed(l as any, { ...next, deviceId: 'mac2' }), null);
  assert.equal(refreshed(l as any, null), null);
  assert.equal(refreshed(hostIdentity() as any, next), null);
  assert.equal(refreshed(next, { ...next, expMs: 9 })?.expMs, 9);
});

test('the lane registers a Host; frames go live both ways and are never stored; each end hears the other', async () => {
  const r = await rig();
  const app = await r.connect(lane());
  await app.say({ t: 'host.register', host: HOST, pair: PAIR, hash: hash(SECRET), rid: 'r1' });
  assert.deepEqual(app.socket.last(), { t: 'ok', op: 'host.register', host: HOST, pair: PAIR, rid: 'r1' });
  // a frame while the Host is away is refused, not stored
  await app.say(hf('m2p', 1));
  assert.deepEqual(app.socket.last(), { t: 'error', code: 'peer_offline', pair: PAIR, ctr: 1 });
  const host = await r.connect(hostIdentity());
  const hello = host.socket.of('hello')[0];
  assert.equal(hello.kind, 'host');
  assert.deepEqual(hello.pairs, [{ pair: PAIR, role: 'phone', joined: true, peerOnline: true, presence: 'gone' }]);
  assert.deepEqual(app.socket.events('peer').at(-1), { t: 'event', ev: 'peer', pair: PAIR, online: true });
  assert.ok((await r.hub.hosts.get(HOST))?.lastSeenAt, 'last seen is noted');
  await app.say(hf('m2p', 1));
  await host.say(hf('p2m', 1));
  assert.equal(host.socket.of('frame').length, 1);
  assert.equal(app.socket.of('frame').length, 1);
  assert.equal(app.socket.of('ack').length, 0, 'live frames are not acknowledged');
  const stored = await db.query('SELECT count(*) AS c FROM relay_mailbox');
  assert.equal(Number(stored.rows[0].c), 0);
  // a frame in the wrong direction, or for a pair the Host is not on
  await host.say(hf('m2p', 2));
  assert.equal(host.socket.last().code, 'bad_dir');
  // the Host goes: the lane hears it
  host.h.close(1006);
  const { settle } = await import('./support/relayKit.ts');
  await settle(r.hub);
  assert.deepEqual(app.socket.events('peer').at(-1), { t: 'event', ev: 'peer', pair: PAIR, online: false });
});

test('a Host that connects while its app is away tells nobody', async () => {
  const r = await rig();
  const app = await r.connect(lane());
  await app.say({ t: 'host.register', host: HOST, pair: PAIR, hash: hash(SECRET) });
  app.h.close(1000);
  const { settle } = await import('./support/relayKit.ts');
  await settle(r.hub);
  const host = await r.connect(hostIdentity());
  assert.equal(host.socket.of('hello')[0].pairs[0].peerOnline, false);
  assert.equal(host.socket.closedWith, null);
});

test('a peer whose socket does not take a frame is answered peer_offline', async () => {
  const r = await rig();
  const app = await r.connect(lane());
  await app.say({ t: 'host.register', host: HOST, pair: PAIR, hash: hash(SECRET) });
  const host = await r.connect(hostIdentity());
  host.socket.failSend = true;
  await app.say(hf('m2p', 1));
  assert.equal(app.socket.last().code, 'peer_offline');
});

test('register refuses bad input, a taken id or pair, and the account past its Host cap; only the lane may ask', async () => {
  const r = await rig({ hostsPerAccount: 1 });
  const app = await r.connect(lane());
  for (const bad of [
    { host: 'nope', pair: PAIR, hash: hash(SECRET) },
    { host: HOST, pair: 'nope', hash: hash(SECRET) },
    { host: HOST, pair: PAIR, hash: 'xyz' },
    { host: HOST, pair: PAIR },
  ]) {
    await app.say({ t: 'host.register', ...bad });
    assert.equal(app.socket.last().code, 'bad_message');
  }
  await app.say({ t: 'host.register', host: HOST, pair: PAIR, hash: hash(SECRET) });
  await app.say({ t: 'host.register', host: HOST2, pair: 'p_hostpair02', hash: hash(SECRET) });
  assert.deepEqual(app.socket.last(), { t: 'error', code: 'host_limit', host: HOST2 });
  const roomy = await rig({ hostsPerAccount: 5 });
  const a2 = await roomy.connect(lane());
  await a2.say({ t: 'host.register', host: HOST, pair: PAIR, hash: hash(SECRET) });
  await a2.say({ t: 'host.register', host: HOST, pair: 'p_hostpair02', hash: hash(SECRET) });
  assert.equal(a2.socket.last().code, 'host_exists');
  await a2.say({ t: 'host.register', host: HOST2, pair: PAIR, hash: hash(SECRET) });
  assert.equal(a2.socket.last().code, 'host_exists');
  // a desktop on the phone lane, a phone or a Host cannot use host.*; an unknown host.* or other type is a bad message
  const mac = await roomy.connect({ userId: 'u1', deviceId: 'mac9', kind: 'desktop', expMs: Date.UTC(2031, 0, 1) });
  await mac.say({ t: 'host.register', host: HOST2, pair: 'p_hostpair03', hash: hash(SECRET) });
  assert.equal(mac.socket.last().code, 'forbidden');
  await mac.say({ t: 'nonsense' });
  assert.equal(mac.socket.last().code, 'bad_message');
  await a2.say({ t: 'host.nonsense' });
  assert.equal(a2.socket.last().code, 'bad_message');
  // the lane cannot remove a Host's pair on its own, and neither can the Host
  await a2.say({ t: 'pair.remove', pair: PAIR });
  assert.equal(a2.socket.last().code, 'forbidden');
});

test('revoke closes the Host with 4403, forgets its credential and pair, and is safe to repeat; list names the lane’s Hosts', async () => {
  const r = await rig();
  const app = await r.connect(lane());
  await app.say({ t: 'host.register', host: HOST, pair: PAIR, hash: hash(SECRET) });
  await app.say({ t: 'host.register', host: HOST2, pair: 'p_hostpair02', hash: hash(SECRET) });
  const host = await r.connect(hostIdentity());
  await app.say({ t: 'host.list', rid: 'l' });
  const listed = app.socket.last();
  assert.equal(listed.op, 'host.list');
  assert.deepEqual(
    listed.hosts.map((h: any) => [h.host, h.pair, h.online, typeof h.lastSeenAt]),
    [
      [HOST, PAIR, true, 'number'],
      [HOST2, 'p_hostpair02', false, 'object'],
    ],
  );
  await app.say({ t: 'host.revoke', host: HOST, rid: 'v' });
  assert.deepEqual(app.socket.last(), { t: 'ok', op: 'host.revoke', host: HOST, removed: true, rid: 'v' });
  assert.deepEqual(host.socket.closedWith, { code: 4403, reason: 'revoked' });
  assert.ok(app.socket.events('pair.removed').some((e: any) => e.pair === PAIR));
  assert.equal(await r.hub.hosts.get(HOST), null);
  await app.say({ t: 'host.revoke', host: HOST });
  assert.equal(app.socket.last().removed, false);
  await app.say({ t: 'host.revoke', host: 'bad' });
  assert.equal(app.socket.last().code, 'bad_message');
  // another device of the account revokes: the issuing app's lane is the one told
  const second = await r.connect(lane('mac2'));
  await app.say({ t: 'host.register', host: 'h_host0000000000003', pair: 'p_hostpair03', hash: hash(SECRET) });
  await second.say({ t: 'host.revoke', host: 'h_host0000000000003' });
  assert.equal(second.socket.last().removed, true);
  assert.ok(app.socket.events('pair.removed').some((e: any) => e.pair === 'p_hostpair03'));
  assert.ok(!second.socket.events('pair.removed').some((e: any) => e.pair === 'p_hostpair03'));
  // another account cannot revoke this account's Host
  const other = await r.connect(laneOf({ userId: 'u2', deviceId: 'mac7', kind: 'desktop', expMs: Date.UTC(2031, 0, 1) }));
  await other.say({ t: 'host.revoke', host: HOST2 });
  assert.equal(other.socket.last().removed, false);
  assert.ok(await r.hub.hosts.get(HOST2));
});

test('a Host whose credential went while its socket was starting is closed', async () => {
  const r = await rig();
  const host = await r.connect(hostIdentity('h_neverregistered0001'));
  assert.deepEqual(host.socket.closedWith, { code: 4403, reason: 'revoked' });
});

test('revoking the app device takes its Hosts and closes its lane; a purge takes every Host of the account', async () => {
  const r = await rig();
  const app = await r.connect(lane());
  await app.say({ t: 'host.register', host: HOST, pair: PAIR, hash: hash(SECRET) });
  const host = await r.connect(hostIdentity());
  await r.hub.revoke({ userId: 'u1', deviceId: 'mac1' });
  assert.deepEqual(host.socket.closedWith, { code: 4403, reason: 'revoked' });
  assert.deepEqual(app.socket.closedWith, { code: 4403, reason: 'revoked' });
  assert.equal(await r.hub.hosts.get(HOST), null);
  // the revoked device's lane is refused when it comes back
  const again = await r.connect(lane());
  assert.deepEqual(again.socket.closedWith, { code: 4403, reason: 'revoked' });

  const p = await rig();
  const a = await p.connect(lane('mac2'));
  await a.say({ t: 'host.register', host: HOST2, pair: 'p_hostpair02', hash: hash(SECRET) });
  const h2 = await p.connect(hostIdentity(HOST2));
  await purgeAccount(p.hub, { userId: 'u1', deviceIds: [] });
  assert.equal(await p.hub.hosts.get(HOST2), null);
  assert.equal(h2.socket.closedWith?.code, 4403);
});

test('a Host socket does not count against the account device cap', async () => {
  const r = await rig({ maxConnectionsPerAccount: 1, hostsPerAccount: 5 });
  const app = await r.connect(lane());
  await app.say({ t: 'host.register', host: HOST, pair: PAIR, hash: hash(SECRET) });
  const host = await r.connect(hostIdentity());
  assert.equal(host.socket.closedWith, null);
  const phone = await r.connect({ userId: 'u1', deviceId: 'ph1', kind: 'phone', expMs: Date.UTC(2031, 0, 1) });
  assert.equal(phone.socket.closedWith?.code, 4429, 'the device cap still holds for the rest');
  // the ping round prunes the auth buckets with the others
  tickHub(r.hub, 3, 60_000);
});

test('verifyHost: the right secret is the Host; a wrong or unknown one is revoked, limited per address and Host id', async () => {
  const r = await rig({ hostAuthBurst: 2, hostAuthRate: 1 });
  const app = await r.connect(lane());
  await app.say({ t: 'host.register', host: HOST, pair: PAIR, hash: hash(SECRET) });
  assert.deepEqual(await verifyHost(r.hub, `mh1.${HOST}.${SECRET}`, '1.1.1.1'), { ...hostIdentity(), ip: '1.1.1.1' });
  assert.equal(await verifyHost(r.hub, `mh1.${HOST}.${'B'.repeat(43)}`, '1.1.1.1'), 'revoked');
  assert.equal(await verifyHost(r.hub, 'mh1.junk', '1.1.1.1'), null, 'not a Host token at all');
  assert.equal(await verifyHost(r.hub, `mh1.${HOST}.${'C'.repeat(43)}`, '1.1.1.1'), 'revoked');
  assert.equal(await verifyHost(r.hub, `mh1.${HOST}.${'D'.repeat(43)}`, '1.1.1.1'), 'revoked', 'the burst is used up and then some');
  assert.equal(await verifyHost(r.hub, `mh1.${HOST}.${SECRET}`, '1.1.1.1'), 'limited');
  // a dead credential of another Host behind the same address holds nobody else up
  for (let i = 0; i < 5; i++)
    assert.equal(await verifyHost(r.hub, `mh1.h_unknown000000000001.${SECRET}`, '3.3.3.3'), i < 3 ? 'revoked' : 'limited');
  assert.deepEqual(await verifyHost(r.hub, `mh1.${HOST}.${SECRET}`, '3.3.3.3'), { ...hostIdentity(), ip: '3.3.3.3' });
  assert.deepEqual(
    await verifyHost(r.hub, `mh1.${HOST}.${SECRET}`, '2.2.2.2'),
    { ...hostIdentity(), ip: '2.2.2.2' },
    'another address is not held up',
  );
  r.clock.advance(5000);
  assert.deepEqual(await verifyHost(r.hub, `mh1.${HOST}.${SECRET}`, '1.1.1.1'), { ...hostIdentity(), ip: '1.1.1.1' });
  // a caller that makes up a new Host id for every try is held at the address's wider limit
  const wide = await rig({ hostAuthBurst: 2, hostAddressBurst: 3, hostAddressRate: 1 });
  const seen: unknown[] = [];
  for (let i = 0; i < 5; i++) seen.push(await verifyHost(wide.hub, `mh1.h_made${String(i).padStart(15, '0')}.${SECRET}`, '4.4.4.4'));
  assert.deepEqual(seen, ['revoked', 'revoked', 'revoked', 'revoked', 'limited']);
});

test('over real sockets: a Host with its credential and the app on its lane talk; a wrong credential is closed 4403, a flood 429', async () => {
  const keys = await makeKeys();
  await reset();
  const config = loadConfig({
    AUTH_PUBLIC_KEY: keys.publicPem,
    DATABASE_URL: 'postgres://unused',
    HOST_AUTH_BURST: '1',
    HOSTS_PER_ACCOUNT: '3',
  });
  assert.equal(config.limits.hostsPerAccount, 3);
  const relay = createRelay({
    config,
    db: db as any,
    verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
    send: null,
  });
  const port = await relay.listen(0, '127.0.0.1');
  after(() => relay.close());
  const open = async (token: string, path = '/v1/ws') => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${token}` } });
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
    await new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)));
    const next = async (pred: (m: any) => boolean) => {
      for (let i = 0; i < 200; i++) {
        const m = inbox.find(pred);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('no message');
    };
    await next((m) => m.t === 'hello');
    return { ws, inbox, next };
  };
  const app = await open(await keys.sign('u1', 'mac1'), '/v1/ws?as=hostlink');
  assert.equal(app.inbox[0].device, 'mac1~h');
  app.ws.send(JSON.stringify({ t: 'host.register', host: HOST, pair: PAIR, hash: hash(SECRET), rid: 'a' }));
  await app.next((m) => m.op === 'host.register');
  const host = await open(`mh1.${HOST}.${SECRET}`);
  host.ws.send(JSON.stringify(hf('p2m', 1)));
  const got = await app.next((m) => m.t === 'frame');
  assert.equal(got.pair, PAIR);
  // a junk token on the host lane is refused; a wrong secret is closed 4403 (the Host's link can read that), then the address is limited
  const refused = async (token: string, path = '/v1/ws') => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return new Promise<string>((r) => {
      ws.once('error', (e) => r(e.message));
      ws.once('close', (code) => r(`closed ${code}`));
    });
  };
  assert.match(await refused('junk', '/v1/ws?as=hostlink'), /401/);
  assert.equal(await refused(`mh1.${HOST}.${'B'.repeat(43)}`), 'closed 4403');
  assert.equal(await refused(`mh1.${HOST}.${'B'.repeat(43)}`), 'closed 4403');
  assert.match(await refused(`mh1.${HOST}.${'B'.repeat(43)}`), /429/);
  assert.match(await refused('mh1.junk'), /401/);
  host.ws.close();
  app.ws.close();
  // the purge digest helper is the one the account service mirrors
  assert.equal(digestOf(['b', 'a']), digestOf(['a', 'b']));
});

test('presence on a Host pair is the heartbeat: answered, never broadcast', async () => {
  const r = await rig();
  const app = await r.connect(lane());
  await app.say({ t: 'presence', state: 'online', rid: 'b' });
  assert.deepEqual(app.socket.last(), { t: 'ok', op: 'presence', rid: 'b' });
  assert.equal(r.hub.presence.size, 0);
});
