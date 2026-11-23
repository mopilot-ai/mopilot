// A deleted account's data on the relay: every device revoked, every pair, mailbox and push token gone, the Macs told, and the same request again a no-op.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { loadConfig } from '../relay/src/config.mjs';
import { createVerifier } from '../relay/src/auth.mjs';
import { createRelay } from '../relay/src/server.mjs';
import { digestOf, purgeAccount } from '../relay/src/purge.mjs';
import { migrateDurable } from '../relay/src/durableStore.mjs';
import { makeDb, makeHub, makeKeys, frame, P, settle } from './support/relayKit.ts';

const { db, reset } = await makeDb();
await migrateDurable(db as any);
beforeEach(reset);

async function twoAccounts() {
  const r = makeHub(db, { durable: true });
  const mac1 = await r.join('u1', 'mac1', 'desktop');
  const ph1 = await r.join('u1', 'ph1', 'phone');
  const mac2 = await r.join('u2', 'mac2', 'desktop');
  const ph2 = await r.join('u2', 'ph2', 'phone');
  await mac1.say({ t: 'pair.register', pair: P });
  await ph1.say({ t: 'pair.join', pair: P });
  await mac2.say({ t: 'pair.register', pair: 'p_other0002' });
  await ph2.say({ t: 'pair.join', pair: 'p_other0002' });
  await ph1.say({ t: 'push.register', platform: 'apns', token: 'tok-1' });
  await ph2.say({ t: 'push.register', platform: 'apns', token: 'tok-2' });
  await ph1.say({ t: 'activity.register', token: 'ab'.repeat(32) });
  await ph2.say({ t: 'activity.register', token: 'cd'.repeat(32) });
  await ph1.say(frame('p2m', 1));
  return { r, mac1, ph1, mac2, ph2 };
}
const count = async (sql: string, ...params: unknown[]) => Number((await db.query(sql, params as any)).rows[0].n);

test('purging an account removes its pairs, mailbox, push tokens and sockets, tells the Mac, and leaves other accounts alone', async () => {
  const { r, mac1, ph1, mac2, ph2 } = await twoAccounts();
  mac1.socket.sent.length = 0;
  const done = await purgeAccount(r.hub, { userId: 'u1', deviceIds: ['mac1', 'ph1', 'ph1-old'] });
  assert.deepEqual(done, { devices: 3, pairs: 1 });
  assert.equal(await r.store.getPair(P), null);
  assert.equal(await count("SELECT count(*)::int AS n FROM relay_push_tokens WHERE user_id = 'u1'"), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM relay_activity_tokens WHERE user_id = 'u1'"), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM relay_mailbox WHERE pair_id = $1', P), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM remote_durable.frames WHERE pair_id = $1', P), 0);
  assert.equal(mac1.socket.closedWith?.code, 4403);
  assert.equal(ph1.socket.closedWith?.code, 4403);
  // the revoked rows no longer name the account
  assert.equal(await count("SELECT count(*)::int AS n FROM relay_revoked_devices WHERE user_id = 'u1'"), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM relay_revoked_devices WHERE user_id = 'deleted'"), 3);
  // the other account is untouched
  assert.ok(await r.store.getPair('p_other0002'));
  assert.equal(await count("SELECT count(*)::int AS n FROM relay_push_tokens WHERE user_id = 'u2'"), 1);
  assert.equal(await count("SELECT count(*)::int AS n FROM relay_activity_tokens WHERE user_id = 'u2'"), 1);
  assert.equal(mac2.socket.closedWith, null);
  assert.equal(ph2.socket.closedWith, null);
  // a revoked device cannot come back
  const again = await r.join('u1', 'ph1', 'phone');
  assert.equal(again.socket.closedWith?.code, 4403);
});

test('the Mac of a pair whose phone is purged is told, and a second purge changes nothing', async () => {
  const { r, mac1 } = await twoAccounts();
  mac1.socket.sent.length = 0;
  // only the phone is named: the Mac's pair goes with it, and the Mac hears it
  await purgeAccount(r.hub, { userId: 'u1', deviceIds: ['ph1'] });
  assert.deepEqual(
    mac1.socket.events('pair.removed').map((e: any) => [e.pair, e.reason]),
    [[P, 'revoked']],
  );
  assert.deepEqual(await purgeAccount(r.hub, { userId: 'u1', deviceIds: ['ph1'] }), { devices: 1, pairs: 0 });
  assert.equal(await count("SELECT count(*)::int AS n FROM relay_revoked_devices WHERE device_id = 'ph1'"), 1);
});

test('what no listed device holds still goes: a pair of an unlisted device, and a socket of the user that was not named', async () => {
  const { r, mac1, ph1 } = await twoAccounts();
  const stray = await r.join('u1', 'mac9', 'desktop');
  await stray.say({ t: 'pair.register', pair: 'p_stray0001' });
  const done = await purgeAccount(r.hub, { userId: 'u1', deviceIds: [] });
  assert.equal(done.pairs, 2);
  assert.equal(await r.store.getPair('p_stray0001'), null);
  assert.equal(await r.store.getPair(P), null);
  assert.equal(stray.socket.closedWith?.code, 4403);
  assert.equal(mac1.socket.closedWith?.code, 4403);
  assert.equal(ph1.socket.closedWith?.code, 4403);
});

test('revoked-device rows are forgotten after a week, not before', async () => {
  const r = makeHub(db);
  await r.store.revokeDevice({ userId: 'u1', deviceId: 'old', now: r.clock.t });
  r.clock.advance(7 * 24 * 3600_000 - 1);
  await r.store.sweepRevoked(r.clock.t);
  assert.equal(await r.store.isRevoked('old'), true);
  r.clock.advance(2);
  await r.store.sweepRevoked(r.clock.t);
  assert.equal(await r.store.isRevoked('old'), false);
  await settle(r.hub);
});

test('POST /v1/account/purge needs the purge audience, a sane body, and answers what it removed', async () => {
  const keys = await makeKeys();
  const config = loadConfig({ AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused' });
  const relay = createRelay({
    config,
    db: db as any,
    verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
    send: null,
  });
  const port = await relay.listen(0, '127.0.0.1');
  after(() => relay.close());
  const url = `http://127.0.0.1:${port}/v1/account/purge`;
  const post = (token: string | null, body: unknown, raw = false) =>
    fetch(url, {
      method: 'POST',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      body: raw ? String(body) : JSON.stringify(body),
    });
  const purgeFor = (ids: string[], user = 'u1') => keys.sign(user, '-', { aud: 'relay-purge', ttlS: 120, claims: { dh: digestOf(ids) } });
  const purgeToken = await purgeFor([]);
  assert.equal((await post(null, { deviceIds: [] })).status, 401);
  assert.equal((await post(await keys.sign('u1', '-'), { deviceIds: [] })).status, 401, 'an access token cannot purge');
  assert.equal(
    (await post(await keys.sign('u1', '-', { aud: 'relay-revoke', ttlS: 120 }), { deviceIds: [] })).status,
    401,
    'a revocation token cannot purge',
  );
  assert.equal((await post(purgeToken, { deviceIds: 'x' })).status, 400);
  assert.equal((await post(purgeToken, { deviceIds: [1] })).status, 400);
  assert.equal((await post(purgeToken, { deviceIds: Array.from({ length: 501 }, (_, i) => `d${i}`) })).status, 400);
  assert.equal((await post(purgeToken, 'not json', true)).status, 400);
  assert.equal((await post(purgeToken, { deviceIds: ['x'.repeat(5), 'y'.repeat(200_000)] })).status, 400, 'a body over the limit');
  // the same without a length announced: the relay stops reading at the limit
  const chunked = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`{"deviceIds":["${'z'.repeat(100_000)}"]}`));
      c.close();
    },
  });
  assert.equal(
    (await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${purgeToken}` }, body: chunked, duplex: 'half' } as any)).status,
    400,
  );
  // a token for no ids cannot be sent with some, nor one for other ids; a token without a digest or for the user 'deleted' is nothing
  assert.equal((await post(purgeToken, { deviceIds: ['macH'] })).status, 403);
  assert.equal((await post(await purgeFor(['macX']), { deviceIds: ['macH'] })).status, 403);
  assert.equal((await post(await keys.sign('u1', '-', { aud: 'relay-purge', ttlS: 120 }), { deviceIds: [] })).status, 401);
  assert.equal((await post(await purgeFor([], 'deleted'), { deviceIds: [] })).status, 401);
  assert.equal(digestOf(['b', 'a']), digestOf(['a', 'b']), 'the order of the ids does not matter');
  await relay.store.registerPair({ pairId: 'p_http00001', userId: 'u1', macDeviceId: 'macH', now: Date.now(), joinMs: 60_000 });
  const res = await post(await purgeFor(['macH']), { deviceIds: ['macH'] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { devices: 1, pairs: 1 });
  assert.equal(await relay.store.getPair('p_http00001'), null);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { authorization: `Bearer ${await keys.sign('u1', 'macH')}` } });
  assert.equal(await new Promise((r) => ws.once('close', r)), 4403);
});

test('a verifier built without a purge audience still demands relay-purge, never any audience', async () => {
  const keys = await makeKeys();
  const config = loadConfig({ AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused' });
  const { purgeAudience: _unset, ...auth } = config.auth;
  const verifier = createVerifier({ ...auth, publicKeyPem: keys.publicPem });
  assert.deepEqual(await verifier.verifyPurge(await keys.sign('u1', '-', { aud: 'relay-purge', ttlS: 120, claims: { dh: 'abc' } })), {
    userId: 'u1',
    digest: 'abc',
  });
  assert.equal(await verifier.verifyPurge(await keys.sign('u1', '-')), null);
  assert.equal(
    loadConfig({ AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'x', AUTH_PURGE_AUDIENCE: 'custom' }).auth.purgeAudience,
    'custom',
  );
});

test('a purge or a revocation for one account cannot touch another account’s device', async () => {
  const { r, mac2, ph2 } = await twoAccounts();
  // u1's signed request names u2's devices
  assert.deepEqual(await purgeAccount(r.hub, { userId: 'u1', deviceIds: ['mac2', 'ph2'] }), { devices: 2, pairs: 1 });
  assert.ok(await r.store.getPair('p_other0002'), 'the other account’s pair was removed');
  assert.equal(await r.store.isRevoked('mac2'), false);
  assert.equal(await r.store.isRevoked('ph2'), false);
  assert.equal(mac2.socket.closedWith, null);
  assert.equal(ph2.socket.closedWith, null);
  assert.equal(await r.store.revokeDevice({ userId: 'u1', deviceId: 'mac2', now: r.clock.t }), null);
  // a socket that has no pair yet belongs to its own account too
  const lone = await r.join('u2', 'lone2', 'phone');
  assert.equal(await r.hub.revoke({ userId: 'u1', deviceId: 'lone2' }), 0);
  assert.equal(lone.socket.closedWith, null);
  assert.equal(await r.store.isRevoked('lone2'), false);
});

test('a purge that fails part way leaves a retry the pairs to tell the Macs about, and a failing sweep still clears the pair cache', async () => {
  const { r, mac1 } = await twoAccounts();
  const real = r.store.db.query.bind(r.store.db);
  let fail = true;
  r.store.db.query = async (sql: string, params?: unknown[]) => {
    if (fail && /UPDATE relay_revoked_devices SET user_id = 'deleted'/.test(sql)) throw new Error('database dropped');
    return real(sql, params);
  };
  await assert.rejects(purgeAccount(r.hub, { userId: 'u1', deviceIds: [] }), /database dropped/);
  assert.ok(await r.store.getPair(P), 'the pairs are deleted last, so none was lost with the error');
  fail = false;
  mac1.socket.sent.length = 0;
  assert.equal((await purgeAccount(r.hub, { userId: 'u1', deviceIds: [] })).pairs, 1);
  assert.equal(await r.store.getPair(P), null);
  // the sweep clears the cache even when a step fails
  let cleared = 0;
  r.hub.cache.clear = () => void cleared++;
  r.store.sweepRevoked = async () => {
    throw new Error('sweep broke');
  };
  await assert.rejects(r.hub.sweep(), /sweep broke/);
  assert.equal(cleared, 1);
});
