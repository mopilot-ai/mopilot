// The relay over real sockets: the upgrade is authenticated by the account JWT, a Mac and a phone talk through /v1/ws, a signed revocation closes a device's socket, and main.mjs starts it all from the environment.
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import { loadConfig } from '../relay/src/config.mjs';
import { createVerifier } from '../relay/src/auth.mjs';
import { createRelay } from '../relay/src/server.mjs';
import { createPool, run, start } from '../relay/src/main.mjs';
import { makeDb, makeKeys, idle } from './support/relayKit.ts';
import { waitFor } from './support/waitFor.ts';

const keys = await makeKeys();
const { db, reset } = await makeDb();
const env = { AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused' };
const config = loadConfig(env);
const P = 'p_pair00001';
const b64 = (n: number) => Buffer.alloc(n, 3).toString('base64');

const sent: any[] = [];
const relay = createRelay({
  config,
  db: db as any,
  verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
  send: async (m: any) => (sent.push(m), { ok: true }),
});
const port = await relay.listen(0, '127.0.0.1');
after(() => relay.close());
const base = `http://127.0.0.1:${port}`;

type Client = WebSocket & { inbox: any[]; next(pred: (m: any) => boolean): Promise<any> };
async function connect(token: string, path = '/v1/ws'): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${token}` } }) as Client;
  ws.inbox = [];
  const waiting: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    ws.inbox.push(m);
    const i = waiting.findIndex((w) => w.pred(m));
    if (i >= 0) waiting.splice(i, 1)[0].resolve(m);
  });
  ws.next = (pred) => {
    const seen = ws.inbox.find(pred);
    return seen ? Promise.resolve(seen) : new Promise((resolve) => waiting.push({ pred, resolve }));
  };
  await new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)));
  await ws.next((m) => m.t === 'hello');
  return ws;
}
const closed = (ws: WebSocket) => new Promise<number>((r) => ws.once('close', r));

test('health, unknown routes and a refused upgrade', async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/v1/revoke`)).status, 404);
  for (const [token, path] of [
    ['', '/v1/ws'],
    ['junk', '/v1/ws'],
    [await keys.sign('u1', 'm1'), '/other'],
  ]) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const err = await new Promise<Error>((r) => ws.once('error', r));
    assert.match(err.message, /401/);
  }
});

test('health says 503 when the database is down', async () => {
  const sick = createRelay({
    config,
    db: {
      query: async () => {
        throw new Error('down');
      },
    } as any,
    verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
    send: null,
  });
  const p = await sick.listen(0, '127.0.0.1');
  after(() => sick.close());
  const res = await fetch(`http://127.0.0.1:${p}/healthz`);
  assert.equal(res.status, 503);
  assert.equal(await res.text(), 'database unavailable');
});

test('a Mac and a phone pair, exchange sealed frames, and the phone gets a fixed-title push request answered', async () => {
  await reset();
  const mac = await connect(await keys.sign('u1', 'mac1'));
  const phone = await connect(await keys.sign('u1', 'ph1', { kind: 'phone' }));
  mac.send(JSON.stringify({ t: 'pair.register', pair: P }));
  await mac.next((m) => m.op === 'pair.register');
  phone.send(JSON.stringify({ t: 'pair.join', pair: P }));
  await phone.next((m) => m.op === 'pair.join');
  await mac.next((m) => m.ev === 'pair.joined');
  const f = { t: 'frame', pair: P, dir: 'm2p', ctr: 1, nonce: b64(24), box: b64(2000) };
  mac.send(JSON.stringify(f));
  assert.equal((await mac.next((m) => m.t === 'ack')).via, 'live');
  assert.deepEqual(await phone.next((m) => m.t === 'frame'), f);
  phone.send(JSON.stringify({ t: 'push.register', platform: 'apns', token: 'apns-token' }));
  await phone.next((m) => m.op === 'push.register');
  mac.send(JSON.stringify({ t: 'push', pair: P, kind: 'needsYou', ref: 'chat-1' }));
  assert.equal((await mac.next((m) => m.t === 'push.result')).status, 'sent');
  assert.equal(sent.at(-1).token, 'apns-token');
  // the largest allowed box goes through the real socket limit
  mac.send(JSON.stringify({ ...f, ctr: 2, box: b64(256 * 1024) }));
  assert.equal((await mac.next((m) => m.t === 'ack' && m.ctr === 2)).via, 'live');
  mac.close();
  phone.close();
});

test('a binary message closes the socket 1003; a socket error terminates it; pongs keep it alive', async () => {
  const ws = await connect(await keys.sign('u1', 'mac2'));
  ws.send(Buffer.from([1, 2, 3]));
  assert.equal(await closed(ws), 1003);
  const ws2 = await connect(await keys.sign('u1', 'mac3'));
  relay.hub.tick();
  await idle(50);
  assert.equal(relay.hub.conns.get('mac3')!.missed, 0);
  const server = [...relay.wss.clients].find((c) => c !== ws2)!;
  const gone = closed(ws2);
  server.emit('error', new Error('reset'));
  await gone;
});

test("POST /v1/revoke with a signed token closes that device's socket and refuses it afterwards", async () => {
  await reset();
  const token = await keys.sign('u1', 'ph5', { kind: 'phone' });
  const ws = await connect(token);
  const done = closed(ws);
  const post = (bearer: string) =>
    fetch(`${base}/v1/revoke`, { method: 'POST', headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
  assert.equal((await post('')).status, 401);
  assert.equal((await post(await keys.sign('u1', 'ph5'))).status, 401);
  assert.equal((await post(await keys.sign('u1', 'ph5', { aud: 'relay-revoke', ttlS: 120 }))).status, 204);
  assert.equal(await done, 4403);
  const again = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(await closed(again), 4403);
});

test('a failing sweep is logged, not fatal', async () => {
  const logs: any[] = [];
  const failing = {
    query: async (sql: string, p?: unknown[]) => {
      if (/DELETE FROM relay_mailbox/.test(sql)) throw new Error('sweep failed');
      return db.query(sql, p as any);
    },
  };
  const r = createRelay({
    config: { ...config, sweepMs: 20, pingMs: 20 },
    db: failing as any,
    verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
    send: null,
    log: (e, d) => logs.push([e, d]),
  });
  await r.listen(0, '127.0.0.1');
  await idle(120);
  await r.close();
  assert.ok(logs.some(([e, d]) => e === 'error' && d.message === 'sweep failed'));
  // and the error with no message
  const odd = createRelay({
    config: { ...config, sweepMs: 20 },
    db: {
      query: async () => {
        throw 'oops';
      },
    } as any,
    verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
    send: null,
    log: (e, d) => logs.push([e, d]),
  });
  await odd.listen(0, '127.0.0.1');
  await idle(80);
  await odd.close();
  assert.ok(logs.some(([, d]) => d.message === 'oops'));
  const quiet = createRelay({
    config: { ...config, sweepMs: 20 },
    db: {
      query: async () => {
        throw new Error('x');
      },
    } as any,
    verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
    send: null,
  });
  await quiet.listen(0, '127.0.0.1');
  await idle(60);
  await quiet.close();
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as any).port;
      s.close(() => resolve(p));
    });
  });

test('start() migrates, serves, and picks the push path from the config', async () => {
  const { db: fresh } = await makeDb();
  const proxied = await start(
    { ...env, PORT: String(await freePort()), HOST: '127.0.0.1', PUSH_MODE: 'proxy', PUSH_PROXY_URL: 'http://127.0.0.1:1/push' },
    { pool: fresh as any },
  );
  assert.equal((await fetch(`http://127.0.0.1:${proxied.port}/healthz`)).status, 200);
  assert.equal(proxied.relay.hub.push.enabled, true);
  await proxied.relay.close();
  const plain = await start({ ...env, PORT: String(await freePort()), HOST: '127.0.0.1' }, { pool: fresh as any });
  assert.equal(plain.relay.hub.push.enabled, false);
  assert.equal(plain.config.push.mode, 'none');
  await plain.relay.close();
});

test('createPool builds a pg pool from the URL', async () => {
  const calls: any[] = [];
  class Pool {
    listeners: Record<string, (e: Error) => void> = {};
    constructor(o: any) {
      calls.push(o);
    }
    on(event: string, fn: (e: Error) => void) {
      this.listeners[event] = fn;
    }
  }
  const pool = await createPool('postgres://h/db', async () => ({ default: { Pool } }) as any);
  assert.ok(pool instanceof Pool);
  assert.deepEqual(calls, [
    {
      connectionString: 'postgres://h/db',
      max: 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: 15000,
      keepAlive: true,
    },
  ]);
  // a dropped idle connection is logged, not an unhandled 'error' event that ends the process
  const err = mock.method(console, 'error', () => undefined);
  try {
    (pool as any).listeners.error(new Error('terminating connection'));
    (pool as any).listeners.error('not an error');
    assert.deepEqual(
      err.mock.calls.map((c) => JSON.parse(String(c.arguments[0]))),
      [
        { event: 'pool_error', message: 'terminating connection' },
        { event: 'pool_error', message: 'not an error' },
      ],
    );
  } finally {
    err.mock.restore();
  }
  // a pool without events (the in-process database) is left as it is
  class Quiet {}
  assert.ok((await createPool('postgres://h/db', async () => ({ default: { Pool: Quiet } }) as any)) instanceof Quiet);
  // the size, the statement timeout and the error listener come from the caller
  const heard: string[] = [];
  const sized = (await createPool('postgres://h/db', async () => ({ default: { Pool } }) as any, {
    max: 4,
    statementTimeoutMs: 9000,
    onError: (e) => heard.push(e.message),
  })) as any;
  assert.deepEqual([calls.at(-1)?.max, calls.at(-1)?.statement_timeout], [4, 9000]);
  sized.listeners.error(new Error('terminating connection'));
  assert.deepEqual(heard, ['terminating connection']);
});

test('start() reports a client the database drops while idle as db_error through its logger, and prints pool_error without one', async () => {
  const { db: fresh } = await makeDb();
  const logged: [string, any][] = [];
  let heard: (e: Error) => void = () => {};
  const pg = {
    default: {
      Pool: function Pool() {
        return Object.assign(fresh, { on: (_: string, fn: (e: Error) => void) => (heard = fn) });
      },
    },
  };
  const started = await start(
    { ...env, PORT: String(await freePort()), HOST: '127.0.0.1' },
    { log: (e, d) => logged.push([e, d]), importPg: async () => pg as any },
  );
  heard(new Error('terminating connection due to administrator command'));
  assert.deepEqual(
    logged.find(([e]) => e === 'db_error'),
    ['db_error', { message: 'terminating connection due to administrator command' }],
  );
  assert.equal((await fetch(`http://127.0.0.1:${started.port}/healthz`)).status, 200);
  await started.relay.close();
  const err = mock.method(console, 'error', () => undefined);
  try {
    const silent = await start({ ...env, PORT: String(await freePort()), HOST: '127.0.0.1' }, { importPg: async () => pg as any });
    heard(new Error('dropped'));
    assert.deepEqual(JSON.parse(String(err.mock.calls.at(-1)!.arguments[0])), { event: 'pool_error', message: 'dropped' });
    await silent.relay.close();
  } finally {
    err.mock.restore();
  }
});

test('without a pool, start() loads pg (the default import resolves it or fails, the injected one is used when given)', async () => {
  // `pg` is installed only in the relay's own image; here it may or may not resolve, and either way the default import runs
  const pool = await createPool('postgres://127.0.0.1:1/none').then(
    (p: any) => p,
    () => null,
  );
  await pool?.end?.();
  // an injected pg whose Pool is the in-process database: start() builds its pool from it
  const { db: fresh } = await makeDb();
  const viaPg = await start(
    { ...env, PORT: String(await freePort()), HOST: '127.0.0.1' },
    {
      importPg: async () => ({
        default: {
          Pool: function Pool() {
            return fresh;
          },
        },
      }),
    },
  );
  assert.equal((await fetch(`http://127.0.0.1:${viaPg.port}/healthz`)).status, 200);
  await viaPg.relay.close();
  await assert.rejects(
    start(
      { ...env, PORT: String(await freePort()) },
      {
        importPg: async () => {
          throw new Error('no pg here');
        },
      },
    ),
    /no pg here/,
  );
});

test('run() logs the port; a bad config prints the reason and sets the exit code', async () => {
  const { db: fresh } = await makeDb();
  const out = mock.method(console, 'log', () => {});
  const err = mock.method(console, 'error', () => {});
  const prev = process.exitCode;
  try {
    const events: any[] = [];
    const up = await run(
      { ...env, PORT: String(await freePort()), HOST: '127.0.0.1' },
      { pool: fresh as any, log: (e, d) => events.push([e, d]) },
    );
    assert.match(String(out.mock.calls.at(-1)!.arguments[0]), /"event":"listening","port":\d+/);
    await up!.relay.close();
    // the default logger prints one JSON line per event
    const logged = await run({ ...env, PORT: String(await freePort()), HOST: '127.0.0.1' }, { pool: fresh as any });
    const ws = new WebSocket(`ws://127.0.0.1:${logged!.port}/v1/ws`, {
      headers: { authorization: `Bearer ${await keys.sign('u1', 'macL')}` },
    });
    await new Promise((r) => ws.once('message', r));
    assert.ok(out.mock.calls.some((c) => /"event":"connect","device":"macL"/.test(String(c.arguments[0]))));
    const wsGone = closed(ws);
    ws.close();
    await wsGone;
    await logged!.relay.close();
    assert.equal(await run({ DATABASE_URL: 'x' }), null);
    assert.match(String(err.mock.calls.at(-1)!.arguments[0]), /^relay: Set AUTH_PUBLIC_KEY/);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = prev;
    out.mock.restore();
    err.mock.restore();
  }
});

test('the process entry (bin.mjs) refuses to start without its configuration', () => {
  const r = spawnSync(process.execPath, ['relay/src/bin.mjs'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /relay: Set AUTH_PUBLIC_KEY/);
});

test('close() ends sockets that are still open', async () => {
  const r = createRelay({
    config,
    db: db as any,
    verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
    send: null,
  });
  const p = await r.listen(0, '127.0.0.1');
  const ws = new WebSocket(`ws://127.0.0.1:${p}/v1/ws`, { headers: { authorization: `Bearer ${await keys.sign('u1', 'macC')}` } });
  await new Promise((resolve) => ws.once('message', resolve));
  const gone = closed(ws);
  await r.close();
  await gone;
});

test('a database error while revoking answers 500 and is logged; the relay keeps serving', async () => {
  const logs: any[] = [];
  const failing = {
    query: async (sql: string, p?: unknown[]) => {
      if (/relay_revoked_devices/.test(sql)) throw new Error('revoke failed');
      return db.query(sql, p as any);
    },
  };
  const verifier = createVerifier({ ...config.auth, publicKeyPem: keys.publicPem });
  for (const log of [(e: string, d: object) => logs.push([e, d]), undefined]) {
    const r = createRelay({ config, db: failing as any, verifier, send: null, log });
    const p = await r.listen(0, '127.0.0.1');
    const res = await fetch(`http://127.0.0.1:${p}/v1/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await keys.sign('u1', 'phX', { aud: 'relay-revoke', ttlS: 120 })}` },
    });
    assert.equal(res.status, 500);
    assert.equal((await fetch(`http://127.0.0.1:${p}/healthz`)).status, 200);
    await r.close();
  }
  assert.ok(logs.some(([e, d]) => e === 'error' && d.message === 'revoke failed'));
  // an error with no message
  const odd = createRelay({
    config,
    db: {
      query: async () => {
        throw 'bare';
      },
    } as any,
    verifier,
    send: null,
    log: (e, d) => logs.push([e, d]),
  });
  const p2 = await odd.listen(0, '127.0.0.1');
  const res2 = await fetch(`http://127.0.0.1:${p2}/v1/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await keys.sign('u1', 'phY', { aud: 'relay-revoke', ttlS: 120 })}` },
  });
  assert.equal(res2.status, 500);
  await odd.close();
  assert.ok(logs.some(([, d]) => d.message === 'bare'));
});

test('start() turns the durable mailbox on by default (hello says acks) and DURABLE_MAILBOX=0 leaves the plain one', async () => {
  const { db: fresh } = await makeDb();
  const on = await start({ ...env, PORT: String(await freePort()), HOST: '127.0.0.1' }, { pool: fresh as any });
  assert.ok(on.relay.hub.mailbox);
  assert.equal(
    (await fresh.query("SELECT 1 FROM information_schema.tables WHERE table_schema='remote_durable' AND table_name='frames'")).rows.length,
    1,
  );
  await on.relay.close();
  const { db: plainDb } = await makeDb();
  const off = await start({ ...env, PORT: String(await freePort()), HOST: '127.0.0.1', DURABLE_MAILBOX: '0' }, { pool: plainDb as any });
  assert.equal(off.relay.hub.mailbox, null);
  assert.equal((await plainDb.query("SELECT 1 FROM information_schema.schemata WHERE schema_name='remote_durable'")).rows.length, 0);
  await off.relay.close();
});

test('a client that resets while its token is still being checked does not take the relay down', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  let asked = false;
  const real = createVerifier({ ...config.auth, publicKeyPem: keys.publicPem });
  const token = await keys.sign('u1', 'mac-1');
  const slow = createRelay({
    config,
    db: db as any,
    verifier: {
      ...real,
      verify: async (token: string) => ((asked = true), await gate, real.verify(token)),
    } as any,
    send: async () => ({ ok: true }),
  });
  const slowPort = await slow.listen(0, '127.0.0.1');
  const client = net.connect(slowPort, '127.0.0.1');
  client.on('error', () => undefined);
  try {
    let listening = -1;
    // the relay's own upgrade handler has already started (and is waiting for the check) when this one runs
    slow.server.on('upgrade', (_req: any, socket: net.Socket) => void (listening = socket.listenerCount('error')));
    await new Promise((r) => client.once('connect', r));
    client.write(
      `GET /v1/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${token}\r\n\r\n`,
    );
    await waitFor(() => asked, 'the token check');
    assert.ok(asked, 'the relay is checking the token');
    assert.ok(listening > 0, 'the socket has an error handler while the token is checked');
    // the client drops with a reset (a phone that lost its network), and the relay finds out before the check ends
    client.resetAndDestroy();
    await new Promise((r) => setTimeout(r, 100));
    release();
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    release();
    client.destroy();
    await slow.close();
  }
});
