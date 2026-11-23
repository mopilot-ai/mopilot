// Add by command's downloads off the relay's own host (relay/src/boot.mjs, finding H-2 in docs/host-threat-model.md): with BOOT_ORIGIN the relay serves boots only on that host and nothing else there, tells the app where in host.boot's answer, refuses its own host's boot links with an update notice, limits the boots an account starts in a day, and logs each download by lane, boot, kind, size and outcome.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../relay/src/config.mjs';
import { createVerifier } from '../relay/src/auth.mjs';
import { createRelay } from '../relay/src/server.mjs';
import { sayScript, SAY, PENDING, PER_DAY } from '../relay/src/boot.mjs';
import { laneOf } from '../relay/src/hosts.mjs';
import { makeDb, makeKeys, makeHub, settle, FakeSocket } from './support/relayKit.ts';
import { waitFor } from './support/waitFor.ts';

const keys = await makeKeys();
const { db, reset } = await makeDb();
const BOOT = `b_${'H'.repeat(22)}`;
const HOST = 'h_host0000000000001';
const ORIGIN = 'https://boot.example.test';

/** A GET with the Host header a proxy would pass on. */
const get = (port: number, path: string, host: string) =>
  new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      })
      .on('error', reject);
  });

test('BOOT_ORIGIN is an https origin or nothing; anything else stops the relay from starting', () => {
  const base = { AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused' };
  assert.equal(loadConfig(base).bootOrigin, null);
  assert.equal(loadConfig({ ...base, BOOT_ORIGIN: ' ' }).bootOrigin, null);
  assert.equal(loadConfig({ ...base, BOOT_ORIGIN: `${ORIGIN}/` }).bootOrigin, ORIGIN);
  assert.equal(loadConfig({ ...base, BOOT_ORIGIN: 'https://boot.example.test:8443' }).bootOrigin, 'https://boot.example.test:8443');
  for (const bad of [
    'http://boot.example.test',
    'https://boot.example.test/v1',
    'https://u:p@boot.example.test',
    'boot.example.test',
    'https://',
  ])
    assert.throws(() => loadConfig({ ...base, BOOT_ORIGIN: bad }), /BOOT_ORIGIN must be an https origin/, bad);
  assert.equal(loadConfig({ ...base, BOOTS_PER_DAY: '3' }).limits.bootsPerDay, 3);
});

test('with a boot host: the app is told it, the relay’s own host refuses boot links, and the boot host serves boots and nothing else', async () => {
  await reset();
  const config = loadConfig({ AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused', BOOT_ORIGIN: ORIGIN });
  const logs: any[] = [];
  const relay = createRelay({
    config,
    db: db as any,
    verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
    send: null,
    log: (event: string, data: object) => logs.push({ event, ...data }),
  });
  const port = await relay.listen(0, '127.0.0.1');
  after(() => relay.close());
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws?as=hostlink`, {
    headers: { authorization: `Bearer ${await keys.sign('u1', 'mac1')}` },
  });
  const inbox: any[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    inbox.push(m);
    if (m.ev !== 'boot.request') return;
    ws.send(JSON.stringify({ t: 'boot.data', req: m.req, data: Buffer.from('#!/bin/sh\necho hi\n').toString('base64'), end: true }));
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'host.boot', boot: BOOT, host: HOST, rid: 'b' }));
  await waitFor(() => inbox.some((m) => m.op === 'host.boot'), 'the relay to take the boot');
  assert.deepEqual(
    inbox.find((m) => m.op === 'host.boot'),
    { t: 'ok', op: 'host.boot', boot: BOOT, base: ORIGIN, rid: 'b' },
  );
  // the relay's own host: no one's installer, an update notice instead, and nothing used up
  const relayHost = `127.0.0.1:${port}`;
  const moved = await get(port, `/v1/boot/${BOOT}`, relayHost);
  assert.equal(moved.body, sayScript(SAY.moved));
  assert.equal(moved.headers['x-content-type-options'], 'nosniff');
  assert.equal((await get(port, `/v1/boot/${BOOT}/bundle/linux-x64-gnu`, relayHost)).status, 404);
  // the boot host serves it, once, marked so no browser shows it as a page
  const served = await get(port, `/v1/boot/${BOOT}`, 'boot.example.test');
  assert.equal(served.body, '#!/bin/sh\necho hi\n');
  assert.equal(served.headers['content-security-policy'], 'sandbox');
  assert.equal(served.headers['x-content-type-options'], 'nosniff');
  assert.equal((await get(port, `/v1/boot/${BOOT}`, 'boot.example.test')).body, sayScript(SAY.gone));
  // the boot host is nothing else: not health, not revoke, not a boot id nobody registered (which is not logged)
  for (const p of ['/healthz', '/v1/revoke', '/metrics', '/nope', '//['])
    assert.equal((await get(port, p, 'boot.example.test')).status, 404, p);
  assert.equal((await get(port, `/v1/boot/b_${'N'.repeat(22)}`, 'boot.example.test')).body, sayScript(SAY.gone));
  // nor a socket: an upgrade on the boot host is refused before any token is read
  const refused = await new Promise<number>((resolve) => {
    const r = http.get({
      host: '127.0.0.1',
      port,
      path: '/v1/ws',
      headers: {
        host: 'boot.example.test',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    r.on('response', (res) => resolve(res.statusCode ?? 0));
    r.on('upgrade', () => resolve(101));
  });
  assert.equal(refused, 401);
  ws.close();
  const lines = logs.filter((l) => l.event === 'boot_serve');
  assert.deepEqual(
    lines.map((l) => [l.device, l.boot, l.kind, l.bytes, l.outcome]),
    [
      ['mac1~h', BOOT.slice(0, 10), 'script', 0, 'moved'],
      ['mac1~h', BOOT.slice(0, 10), 'bundle', 0, 'moved'],
      ['mac1~h', BOOT.slice(0, 10), 'script', 18, 'sent'],
      ['mac1~h', BOOT.slice(0, 10), 'script', 0, 'gone'],
    ],
  );
});

test('an account starts at most a day’s boots; the day after it may again, and another account is not affected', async () => {
  await reset();
  const r = makeHub(db);
  const connect = async (identity: any) => {
    const socket = new FakeSocket();
    const h = r.hub.connect(socket as any, identity);
    await settle(r.hub);
    return {
      socket,
      say: async (m: object) => {
        h.message(JSON.stringify(m));
        await settle(r.hub);
      },
    };
  };
  const lane = (did: string, userId: string) => laneOf({ userId, deviceId: did, kind: 'desktop', expMs: Date.UTC(2031, 0, 1) });
  const app = await connect(lane('mac1', 'u1'));
  const id = (n: number) => `b_${String(n).padStart(22, '0')}`;
  for (let n = 0; n < PER_DAY; n++) {
    await app.say({ t: 'host.boot', boot: id(n), host: HOST });
    assert.equal(app.socket.last().t, 'ok', `boot ${n}`);
    // each ends before the next, so the waiting cap (PENDING) is not what stops them
    await app.say({ t: 'host.unboot', boot: id(n) });
  }
  assert.ok(PER_DAY > PENDING);
  await app.say({ t: 'host.boot', boot: id(99), host: HOST });
  assert.equal(app.socket.last().code, 'boot_quota');
  // without a boot host the answer names none
  const other = await connect(lane('mac2', 'u2'));
  await other.say({ t: 'host.boot', boot: id(98), host: HOST, rid: 'o' });
  assert.deepEqual(other.socket.last(), { t: 'ok', op: 'host.boot', boot: id(98), rid: 'o' });
  r.clock.advance(24 * 3600_000);
  // a day on, the account's old starts are forgotten (the next register sweeps them), and it may start again
  await app.say({ t: 'host.boot', boot: id(99), host: HOST });
  assert.equal(app.socket.last().t, 'ok');
});
