// A phone on the Host lane (Remote Run P1): a phone's account token opens `<device>~h` as a Mac's does, enrolls and revokes Hosts, talks
// to them live, loses every enrollment with its device, and the enrollment cap counts one per client and Host.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { loadConfig } from '../relay/src/config.mjs';
import { createVerifier } from '../relay/src/auth.mjs';
import { createRelay } from '../relay/src/server.mjs';
import { DEFAULT_LIMITS } from '../relay/src/limits.mjs';
import { b64, makeDb, makeHub, makeKeys } from './support/relayKit.ts';

const { db, reset } = await makeDb();
const HOST = 'h_host0000000000001';
const PAIR = 'p_hostpair01';
const SECRET = 'A'.repeat(43);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const hf = (dir: 'm2p' | 'p2m', ctr: number, pair = PAIR) => ({ t: 'frame', pair, dir, ctr, nonce: b64(24), box: b64(40, ctr) });

test('a phone on its lane enrolls a Host and talks to it live, both ways, nothing stored', async () => {
  await reset();
  const r = makeHub(db);
  const phone = await r.lane('u1', 'ph1');
  assert.equal(phone.socket.of('hello')[0].device, 'ph1~h');
  await phone.say({ t: 'host.register', host: HOST, pair: PAIR, hash: hash(SECRET), rid: 'r1' });
  assert.deepEqual(phone.socket.last(), { t: 'ok', op: 'host.register', host: HOST, pair: PAIR, rid: 'r1' });
  await phone.say(hf('m2p', 1));
  assert.equal(phone.socket.last().code, 'peer_offline');
  const host = await r.host(HOST);
  assert.equal(host.socket.of('hello')[0].pairs[0].peerOnline, true);
  await phone.say(hf('m2p', 2));
  await host.say(hf('p2m', 1));
  assert.equal(host.socket.of('frame').length, 1);
  assert.equal(phone.socket.of('frame').length, 1);
  assert.equal(Number((await db.query('SELECT count(*) AS c FROM relay_mailbox')).rows[0].c), 0);
  await phone.say({ t: 'host.list', rid: 'l' });
  assert.equal(phone.socket.last().hosts[0].host, HOST);
});

test('I: the phone lane is its own socket; the phone lane and the phone itself both stay connected', async () => {
  await reset();
  const r = makeHub(db);
  const plain = await r.join('u1', 'ph1', 'phone');
  const lane = await r.lane('u1', 'ph1');
  assert.equal(plain.socket.closedWith, null);
  assert.equal(lane.socket.closedWith, null);
  // the plain socket still has no Host powers
  await plain.say({ t: 'host.register', host: HOST, pair: PAIR, hash: hash(SECRET) });
  assert.equal(plain.socket.last().code, 'forbidden');
});

test('I: another account cannot use a pair id it knows: its lane and its Host get nothing from this pair', async () => {
  await reset();
  const r = makeHub(db);
  const phone = await r.lane('u1', 'ph1');
  await phone.say({ t: 'host.register', host: HOST, pair: PAIR, hash: hash(SECRET) });
  const host = await r.host(HOST);
  const other = await r.lane('u2', 'ph2');
  await other.say(hf('m2p', 1));
  assert.equal(other.socket.last().code, 'unknown_pair');
  assert.equal(host.socket.of('frame').length, 0);
  // it cannot revoke or register over the first account's Host either
  await other.say({ t: 'host.revoke', host: HOST });
  assert.equal(other.socket.last().removed, false);
  assert.ok(await r.hub.hosts.get(HOST));
  await other.say({ t: 'host.register', host: HOST, pair: 'p_hostpair02', hash: hash(SECRET) });
  assert.equal(other.socket.last().code, 'host_exists');
  assert.equal((await r.hub.hosts.get(HOST))?.userId, 'u1');
});

test('I: a revoked phone loses every enrollment, its Hosts are closed, and its lane is refused when it returns', async () => {
  await reset();
  const r = makeHub(db);
  const phone = await r.lane('u1', 'ph1');
  await phone.say({ t: 'host.register', host: HOST, pair: PAIR, hash: hash(SECRET) });
  await phone.say({ t: 'host.register', host: 'h_host0000000000002', pair: 'p_hostpair02', hash: hash(SECRET) });
  const host = await r.host(HOST);
  await r.hub.revoke({ userId: 'u1', deviceId: 'ph1' });
  assert.deepEqual(host.socket.closedWith, { code: 4403, reason: 'revoked' });
  assert.deepEqual(phone.socket.closedWith, { code: 4403, reason: 'revoked' });
  assert.equal(await r.hub.hosts.get(HOST), null);
  assert.equal(await r.hub.hosts.get('h_host0000000000002'), null);
  assert.equal(Number((await db.query('SELECT count(*) AS c FROM relay_pairs')).rows[0].c), 0);
  assert.deepEqual((await r.lane('u1', 'ph1')).socket.closedWith, { code: 4403, reason: 'revoked' });
});

test('W: the cap counts enrollments: a Mac and a phone with the same machine are two, and the default is 40', async () => {
  assert.equal(DEFAULT_LIMITS.hostsPerAccount, 40);
  await reset();
  const r = makeHub(db, { limits: { hostsPerAccount: 2 } });
  const mac = await r.lane('u1', 'mac1', 'desktop');
  const phone = await r.lane('u1', 'ph1');
  await mac.say({ t: 'host.register', host: HOST, pair: PAIR, hash: hash(SECRET) });
  await phone.say({ t: 'host.register', host: 'h_host0000000000002', pair: 'p_hostpair02', hash: hash(SECRET) });
  assert.equal(phone.socket.last().op, 'host.register');
  await phone.say({ t: 'host.register', host: 'h_host0000000000003', pair: 'p_hostpair03', hash: hash(SECRET) });
  assert.deepEqual(phone.socket.last(), { t: 'error', code: 'host_limit', host: 'h_host0000000000003' });
});

test('over real sockets: a phone token on ?as=hostlink is let in on its lane, a desktop one still is, junk is 401', async () => {
  const keys = await makeKeys();
  await reset();
  const config = loadConfig({ AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused' });
  const relay = createRelay({
    config,
    db: db as any,
    verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
    send: null,
  });
  const port = await relay.listen(0, '127.0.0.1');
  after(() => relay.close());
  const hello = async (token: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws?as=hostlink`, { headers: { authorization: `Bearer ${token}` } });
    const first = new Promise<any>((res, rej) => (ws.once('message', (d) => res(JSON.parse(String(d)))), ws.once('error', rej)));
    const m = await first;
    ws.close();
    return m;
  };
  assert.equal((await hello(await keys.sign('u1', 'ph1', { kind: 'phone' }))).device, 'ph1~h');
  assert.equal((await hello(await keys.sign('u1', 'mac1'))).device, 'mac1~h');
});
