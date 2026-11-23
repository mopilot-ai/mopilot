// Admission a client can read, and the account switch: a full relay and an account at its device cap are closed with their own codes, an account switched off loses its live sockets and is refused until it is switched on (by the account service's word, or by a token issued after the switch-off), and /metrics reports the caps, what fills them and every refusal.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import WebSocket from 'ws';
import { loadConfig } from '../relay/src/config.mjs';
import { createVerifier } from '../relay/src/auth.mjs';
import { createRelay } from '../relay/src/server.mjs';
import { purgeAccount } from '../relay/src/purge.mjs';
import {
  CLOSE_ACCOUNT_LIMIT,
  CLOSE_CAPACITY,
  CLOSE_DISABLED,
  REFUSAL_REASONS,
  accountDisabled,
  closeOf,
  setAccountAccess,
} from '../relay/src/access.mjs';
import { refusalOf } from '../shared/remote/relayRefusal.mjs';
import { AUTH, FakeSocket, makeDb, makeHub, makeKeys, P, settle } from './support/relayKit.ts';
import { waitFor } from './support/waitFor.ts';

const keys = await makeKeys();
const { db, reset } = await makeDb();
beforeEach(reset);

const closing: Array<() => Promise<void>> = [];
after(async () => {
  for (const close of closing) await close();
});

const T0 = Date.UTC(2030, 0, 1);
const disabledRow = async (user: string) =>
  (await db.query('SELECT disabled_at FROM relay_disabled_accounts WHERE user_id = $1', [user])).rows[0];

test('each refusal has its own close code, and the apps read the same codes', () => {
  assert.deepEqual(closeOf('busy'), [4503, 'capacity']);
  assert.deepEqual(closeOf('account_limit'), [4429, 'account_limit']);
  assert.deepEqual(closeOf('account_disabled'), [4423, 'account_disabled']);
  assert.deepEqual(closeOf('restarting'), [1012, 'restarting']);
  assert.deepEqual(REFUSAL_REASONS, ['restarting', 'busy', 'account_limit', 'account_disabled']);
  assert.deepEqual([CLOSE_CAPACITY, CLOSE_ACCOUNT_LIMIT, CLOSE_DISABLED].map(refusalOf), ['capacity', 'account_limit', 'disabled']);
});

test('switching an account off closes every socket it has with 4423, leaves other accounts alone and is safe to repeat', async () => {
  const r = makeHub(db);
  const mac = await r.join('u1', 'mac1', 'desktop');
  const phone = await r.join('u1', 'ph1', 'phone');
  const other = await r.join('u2', 'mac2', 'desktop');
  await mac.say({ t: 'pair.register', pair: P });
  await phone.say({ t: 'pair.join', pair: P });
  assert.deepEqual(await setAccountAccess(r.hub, { userId: 'u1', disabled: true, atMs: T0 }), { sockets: 2, frames: 0 });
  await settle(r.hub);
  assert.deepEqual(mac.socket.closedWith, { code: 4423, reason: 'account_disabled' });
  assert.deepEqual(phone.socket.closedWith, { code: 4423, reason: 'account_disabled' });
  assert.equal(other.socket.closedWith, null);
  assert.deepEqual([...r.hub.conns.keys()], ['mac2'], 'its devices are gone from the hub at once, not when their sockets report the close');
  assert.equal(r.pushed.length, 0, 'a Mac closed by the switch raises no "your Mac went offline" push');
  assert.ok(await r.store.getPair(P), 'its pairs stay for the day it is switched on again');
  assert.deepEqual(
    r.logs.find(([event]) => event === 'account_access'),
    ['account_access', { code: 'disabled', sockets: 2 }],
  );
  // again, with an older time: nothing left to close, and the later time stands
  assert.deepEqual(await setAccountAccess(r.hub, { userId: 'u1', disabled: true, atMs: T0 - 5000 }), { sockets: 0, frames: 0 });
  assert.equal(new Date((await disabledRow('u1')).disabled_at).getTime(), T0);
});

test('a switched-off account is refused when its socket starts; switching it on lets it in, and an older switch-on does not undo a newer switch-off', async () => {
  const r = makeHub(db);
  await setAccountAccess(r.hub, { userId: 'u1', disabled: true, atMs: T0 });
  const refused = await r.join('u1', 'mac1', 'desktop');
  assert.deepEqual(refused.socket.closedWith, { code: 4423, reason: 'account_disabled' });
  assert.equal(r.hub.conns.has('mac1'), false);
  assert.match(r.hub.metrics.render(), /^relay_connections_refused_total\{reason="account_disabled"\} 1$/m);
  assert.deepEqual(await setAccountAccess(r.hub, { userId: 'u1', disabled: false, atMs: T0 - 1000 }), { sockets: 0, frames: 0 });
  assert.equal(await r.store.disabledAt('u1'), T0, 'a switch-on made before the switch-off arrived late');
  await setAccountAccess(r.hub, { userId: 'u1', disabled: false, atMs: T0 });
  assert.equal(await r.store.disabledAt('u1'), null);
  assert.deepEqual(r.logs.at(-1), ['account_access', { code: 'enabled' }]);
  r.clock.advance(2000); // the device's connect bucket
  assert.equal((await r.join('u1', 'mac1', 'desktop')).socket.closedWith, null);
});

test('a socket still starting when its account is switched off never joins the hub', async () => {
  const r = makeHub(db);
  const socket = new FakeSocket();
  r.hub.connect(socket as any, { userId: 'u1', deviceId: 'mac1', kind: 'desktop', expMs: r.clock.t + 900_000 });
  assert.deepEqual(await setAccountAccess(r.hub, { userId: 'u1', disabled: true, atMs: T0 }), { sockets: 1, frames: 0 });
  await settle(r.hub);
  assert.deepEqual(socket.closedWith, { code: 4423, reason: 'account_disabled' });
  assert.equal(r.hub.conns.size, 0);
});

test('a token issued after the switch-off the relay holds shows the account is on again; one issued at or before it, and a Host, do not', async () => {
  const r = makeHub(db);
  await r.store.disableAccount('u1', T0);
  const who = (o: object) => ({ userId: 'u1', deviceId: 'd1', kind: 'desktop' as const, expMs: T0 + 900_000, ...o });
  assert.equal(await accountDisabled(r.hub, who({})), true, 'a token that does not say when it was issued');
  assert.equal(await accountDisabled(r.hub, who({ iatMs: T0 })), true, 'issued in the second of the switch-off');
  assert.equal(await accountDisabled(r.hub, who({ kind: 'host', iatMs: T0 + 60_000 })), true, 'a Host shows no account token');
  assert.equal(await r.store.disabledAt('u1'), T0);
  assert.equal(await accountDisabled(r.hub, who({ iatMs: T0 + 1000 })), false);
  assert.equal(await r.store.disabledAt('u1'), null, 'the record is gone, so the Hosts are let in again too');
  assert.deepEqual(r.logs.at(-1), ['account_access', { code: 'enabled_by_token' }]);
  assert.equal(await accountDisabled(r.hub, who({ userId: 'u2' })), false, 'an account never switched off');
});

test('a deleted account takes its switch-off record with it', async () => {
  const r = makeHub(db);
  await r.store.disableAccount('u1', T0);
  await r.store.disableAccount('u2', T0);
  await purgeAccount(r.hub, { userId: 'u1', deviceIds: [] });
  assert.equal(await r.store.disabledAt('u1'), null);
  assert.equal(await r.store.disabledAt('u2'), T0);
});

test('the access token: its own audience, the switch and when it was made', async () => {
  const verifier = createVerifier({ ...AUTH, publicKeyPem: keys.publicPem });
  const off = await verifier.verifyAccess(await keys.sign('u1', '-', { aud: 'relay-access', claims: { st: 'disabled' } }));
  assert.deepEqual([off?.userId, off?.disabled], ['u1', true]);
  assert.ok(Math.abs(off!.atMs - Date.now()) < 5000 && off!.atMs % 1000 === 0);
  assert.equal(
    (await verifier.verifyAccess(await keys.sign('u1', '-', { aud: 'relay-access', claims: { st: 'enabled' } })))?.disabled,
    false,
  );
  assert.equal(await verifier.verifyAccess(await keys.sign('u1', '-', { aud: 'relay-access', claims: { st: 'paused' } })), null);
  assert.equal(
    await verifier.verifyAccess(await keys.sign('u1', 'd1', { claims: { st: 'disabled' } })),
    null,
    'a device token cannot switch an account',
  );
  assert.equal(await verifier.verifyAccess(await keys.sign('u1', '-', { aud: 'relay-revoke', claims: { st: 'disabled' } })), null);
  const custom = createVerifier({ ...AUTH, publicKeyPem: keys.publicPem, accessAudience: 'mine' });
  assert.equal((await custom.verifyAccess(await keys.sign('u1', '-', { aud: 'mine', claims: { st: 'disabled' } })))?.disabled, true);
  // a device token says when it was issued
  const device = await verifier.verify(await keys.sign('u1', 'd1'));
  assert.ok(device!.iatMs > 0 && device!.iatMs <= Date.now());
});

async function serve(env: Record<string, string> = {}, o: { refusedLingerMs?: number; verifier?: any } = {}) {
  const config = loadConfig({ AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused', ...env });
  const logs: any[] = [];
  const relay = createRelay({
    config,
    db: db as any,
    verifier: o.verifier ?? createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
    send: null,
    log: (event, data) => logs.push([event, data]),
    ...(o.refusedLingerMs && { refusedLingerMs: o.refusedLingerMs }),
  });
  const port = await relay.listen(0, '127.0.0.1');
  closing.push(() => relay.close());
  const dial = async (user: string, device: string, kind: 'desktop' | 'phone' = 'desktop') => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, {
      headers: { authorization: `Bearer ${await keys.sign(user, device, { kind })}` },
    });
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
    const closed = new Promise<[number, string]>((resolve) => ws.once('close', (code, reason) => resolve([code, String(reason)])));
    return { ws, inbox, closed, hello: () => waitFor(() => inbox.some((m) => m.t === 'hello'), `the hello of ${device}`) };
  };
  const access = async (user: string, st: string, aud = 'relay-access') =>
    fetch(`http://127.0.0.1:${port}/v1/account/access`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await keys.sign(user, '-', { aud, claims: { st } })}` },
    });
  const scrape = async () => (await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { authorization: 'Bearer scrape' } })).text();
  return { relay, port, dial, access, scrape, logs };
}

test('over real sockets: the account service switches an account off, its live socket is dropped and its next one refused, until it is switched on', async () => {
  const { relay, dial, access, port } = await serve();
  const mac = await dial('u1', 'mac1');
  const other = await dial('u2', 'mac2');
  await mac.hello();
  await other.hello();
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/account/access`, { method: 'POST' })).status, 401, 'no token');
  assert.equal((await access('u1', 'disabled', 'relay')).status, 401, 'a device token');
  assert.equal(mac.ws.readyState, WebSocket.OPEN);
  const off = await access('u1', 'disabled');
  assert.equal(off.status, 200);
  assert.deepEqual(await off.json(), { sockets: 1, frames: 0 });
  assert.deepEqual(await mac.closed, [4423, 'account_disabled']);
  assert.equal(other.ws.readyState, WebSocket.OPEN);
  // a relay token issued before the switch-off (the same second counts) is refused at the upgrade, before the hub sees it
  const again = await dial('u1', 'mac1');
  assert.deepEqual(await again.closed, [4423, 'account_disabled']);
  assert.equal(again.inbox.length, 0);
  assert.equal(relay.hub.all.size, 1);
  assert.deepEqual(await (await access('u1', 'enabled')).json(), { sockets: 0, frames: 0 });
  const back = await dial('u1', 'mac1');
  await back.hello();
  back.ws.close();
  other.ws.close();
  await waitFor(() => !relay.hub.all.size, 'the hub to empty');
});

test('a relay without the access verifier answers 401, and one that is shutting down still answers the upgrade 503', async () => {
  const config = loadConfig({ AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused' });
  const full = createVerifier({ ...config.auth, publicKeyPem: keys.publicPem });
  let draining: any = null;
  // the shutdown begins while the device's token is being checked: the early draining check has passed
  const verifier = {
    verify: async (t: string) => ((draining.hub.draining = true), full.verify(t)),
    verifyRevocation: full.verifyRevocation,
  };
  const s = await serve({}, { verifier });
  draining = s.relay;
  assert.equal((await s.access('u1', 'disabled')).status, 401);
  const late = await s.dial('u9', 'mac9');
  const error = await new Promise<Error>((resolve) => late.ws.once('error', resolve));
  assert.match(error.message, /503/);
});

/** A WebSocket client by hand: it completes the handshake and then does what `then` says with the raw socket, never answering a close. */
async function rawClient(port: number, token: string, then: (socket: net.Socket) => void = () => undefined) {
  const socket = net.connect(port, '127.0.0.1');
  const chunks: Buffer[] = [];
  let acted = false;
  socket.on('data', (d) => {
    chunks.push(Buffer.from(d));
    // the handshake answer and the relay's close frame (0x88) have arrived
    if (!acted && Buffer.concat(chunks).includes(Buffer.from([0x88]))) {
      acted = true;
      then(socket);
    }
  });
  socket.on('error', () => undefined);
  socket.write(
    `GET /v1/ws HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${token}\r\n\r\n`,
  );
  await new Promise((resolve) => socket.once('close', resolve));
  return Buffer.concat(chunks);
}

test("a refused socket is ended whether or not its client answers the close, and a frame that breaks the protocol on it is not the relay's error", async () => {
  const { relay, port } = await serve({ MAX_CONNECTIONS: '1' }, { refusedLingerMs: 40 });
  const holder = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { authorization: `Bearer ${await keys.sign('u1', 'mac1')}` } });
  await waitFor(() => relay.hub.conns.has('mac1'), 'the one socket the relay serves');
  // silent: the relay ends it after the linger
  const silent = await rawClient(port, await keys.sign('u2', 'mac2'));
  assert.match(String(silent), /^HTTP\/1\.1 101 /);
  const closeFrame = silent.subarray(silent.indexOf(Buffer.from([0x88])));
  assert.equal(closeFrame.readUInt16BE(2), 4503);
  // an unmasked frame is a protocol error from a client; a Host with a credential the relay does not hold is refused the same way
  for (const token of [await keys.sign('u3', 'mac3'), `mh1.h_${'a'.repeat(20)}.${'B'.repeat(43)}`]) {
    const answer = await rawClient(port, token, (socket) => socket.write(Buffer.from([0x81, 0x01, 0x61])));
    assert.match(String(answer), /^HTTP\/1\.1 101 /);
  }
  assert.equal(relay.hub.all.size, 1, 'none of them reached the hub');
  assert.equal(holder.readyState, WebSocket.OPEN, 'and the relay is still serving');
  holder.close();
});

test('/metrics reports the caps and what fills them, Host sockets by kind, mailbox limits, switched-off accounts and every refusal from 0', async () => {
  const { relay, dial, access, scrape } = await serve({
    METRICS_TOKEN: 'scrape',
    MAX_CONNECTIONS: '3',
    MAX_CONNECTIONS_PER_ACCOUNT: '2',
    MAILBOX_GLOBAL_MAX_FRAMES: '1234',
    MAILBOX_GLOBAL_MAX_BYTES: '5678',
  });
  const has = (text: string, lines: string[]) => {
    for (const line of lines) assert.ok(text.split('\n').includes(line), `missing: ${line}\n${text}`);
  };
  has(await scrape(), [
    'relay_sockets 0',
    'relay_sockets_limit 3',
    'relay_account_sockets_max 0',
    'relay_account_sockets_limit 2',
    'relay_mailbox_frames_limit 1234',
    'relay_mailbox_bytes_limit 5678',
    'relay_accounts_disabled 0',
    'relay_connections_refused_total{reason="busy"} 0',
    'relay_connections_refused_total{reason="account_limit"} 0',
    'relay_connections_refused_total{reason="account_disabled"} 0',
    'relay_connections_refused_total{reason="restarting"} 0',
    'relay_connections{kind="host"} 0',
    'relay_connections{kind="hostlink"} 0',
  ]);
  const mac = await dial('u1', 'mac1');
  const phone = await dial('u1', 'ph1', 'phone');
  await mac.hello();
  await phone.hello();
  // the account is at its two devices
  assert.deepEqual(await (await dial('u1', 'mac3')).closed, [4429, 'account_limit']);
  const solo = await dial('u2', 'mac2');
  await solo.hello();
  assert.deepEqual(await (await dial('u3', 'mac4')).closed, [4503, 'capacity']);
  // a Host's socket is counted under its own kind (it used to read 0), and not against its account's devices
  const host = new FakeSocket();
  relay.hub.conns.set('h_x', {
    identity: { userId: 'u1', deviceId: 'h_x', kind: 'host' },
    socket: host,
    closed: false,
    gone: false,
  } as any);
  relay.hub.all.add(relay.hub.conns.get('h_x')!);
  await access('u9', 'disabled');
  has(await scrape(), [
    'relay_connections{kind="desktop"} 2',
    'relay_connections{kind="phone"} 1',
    'relay_connections{kind="host"} 1',
    'relay_sockets 4',
    'relay_account_sockets_max 2',
    'relay_connections_refused_total{reason="busy"} 1',
    'relay_connections_refused_total{reason="account_limit"} 1',
    // read from the database at most every 10 s: the scrape above is still the answer
    'relay_accounts_disabled 0',
  ]);
  relay.hub.all.delete(relay.hub.conns.get('h_x')!);
  relay.hub.conns.delete('h_x');
  for (const c of [mac, phone, solo]) c.ws.close();
  await waitFor(() => !relay.hub.all.size, 'the hub to empty');
});

test('the count of switched-off accounts is read from the database, and goes when the database does not answer', async () => {
  let t = T0;
  let down = false;
  const config = loadConfig({ AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused', METRICS_TOKEN: 'scrape' });
  const relay = createRelay({
    config,
    db: {
      query: (sql: string, p?: unknown[]) =>
        down && /relay_disabled_accounts/.test(sql) ? Promise.reject(new Error('down')) : db.query(sql, p as any),
    } as any,
    verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
    send: null,
    now: () => t,
  });
  const port = await relay.listen(0, '127.0.0.1');
  closing.push(() => relay.close());
  const scrape = async () => (await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { authorization: 'Bearer scrape' } })).text();
  await relay.store.disableAccount('u1', T0);
  await relay.store.disableAccount('u2', T0);
  assert.match(await scrape(), /^relay_accounts_disabled 2$/m);
  down = true;
  t += 11_000;
  const failed = await scrape();
  assert.doesNotMatch(failed, /relay_accounts_disabled/);
  assert.match(failed, /^relay_database_up 0$/m);
});

test('a device that keeps dialing a relay that refuses it is held to its connect rate: past the burst the answer is a plain 429, no socket', async () => {
  const { relay, port, dial } = await serve({ MAX_CONNECTIONS: '1', CONNECT_BURST: '3' });
  const holder = await dial('u1', 'mac1');
  await holder.hello();
  for (let i = 0; i < 3; i++) assert.deepEqual(await (await dial('u2', 'mac2')).closed, [4503, 'capacity']);
  const fourth = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { authorization: `Bearer ${await keys.sign('u2', 'mac2')}` } });
  const error = await new Promise<Error>((resolve) => fourth.once('error', resolve));
  assert.match(error.message, /429/);
  // another device is not held by it, and the refusals were all counted
  assert.deepEqual(await (await dial('u3', 'mac3')).closed, [4503, 'capacity']);
  assert.match(relay.metrics.render(), /^relay_connections_refused_total\{reason="busy"\} 5$/m);
  holder.ws.close();
  await waitFor(() => !relay.hub.all.size, 'the hub to empty');
});

test('a full relay asks the database nothing about the sockets it turns away', async () => {
  const config = loadConfig({ AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused', MAX_CONNECTIONS: '1' });
  let asked = 0;
  const relay = createRelay({
    config,
    db: { query: (sql: string, p?: unknown[]) => (/relay_disabled_accounts/.test(sql) && asked++, db.query(sql, p as any)) } as any,
    verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
    send: null,
  });
  const port = await relay.listen(0, '127.0.0.1');
  closing.push(() => relay.close());
  const open = async (user: string, device: string) =>
    new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { authorization: `Bearer ${await keys.sign(user, device)}` } });
  const holder = await open('u1', 'mac1');
  await waitFor(() => relay.hub.conns.has('mac1'), 'the one socket the relay serves');
  const before = asked;
  const refused = await open('u2', 'mac2');
  assert.equal(await new Promise((resolve) => refused.once('close', resolve)), 4503);
  assert.equal(asked, before);
  holder.close();
});

test('a client that goes away while its account is being checked is not taken into the hub', async () => {
  const config = loadConfig({ AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused' });
  let asked!: () => void;
  const checking = new Promise<void>((resolve) => (asked = resolve));
  let answer!: () => void;
  const held = new Promise<void>((resolve) => (answer = resolve));
  const relay = createRelay({
    config,
    db: {
      query: async (sql: string, p?: unknown[]) => {
        // the account check waits until the test lets it answer
        if (/relay_disabled_accounts/.test(sql)) await (asked(), held);
        return db.query(sql, p as any);
      },
    } as any,
    verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
    send: null,
  });
  const port = await relay.listen(0, '127.0.0.1');
  closing.push(() => relay.close());
  const client = net.connect(port, '127.0.0.1');
  client.on('error', () => undefined);
  client.write(
    `GET /v1/ws HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${await keys.sign('u1', 'mac1')}\r\n\r\n`,
  );
  await checking;
  client.resetAndDestroy();
  const connections = () => new Promise<number>((resolve) => relay.server.getConnections((_e, n) => resolve(n)));
  let open = await connections();
  await waitFor(() => (void connections().then((n) => (open = n)), open === 0), 'the relay to see the reset');
  answer();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(relay.hub.all.size, 0);
  assert.equal(relay.wss.clients.size, 0, 'no handshake was made for a socket that is gone');
  // and it still serves the next one
  const next = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { authorization: `Bearer ${await keys.sign('u2', 'mac2')}` } });
  await new Promise((resolve, reject) => (next.once('open', resolve), next.once('error', reject)));
  await waitFor(() => relay.hub.conns.has('mac2'), 'the next device to connect');
  next.close();
});
