// The relay as a process that is deployed: SIGTERM finishes what each connection is doing and tells the endpoints to reconnect (1012), a restarting relay raises no "Mac went offline" push, concurrent starts migrate one after another, and a database that drops an idle client does not end the process.
import { waitFor } from './support/waitFor.ts';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import WebSocket from 'ws';
import { loadConfig } from '../relay/src/config.mjs';
import { createVerifier } from '../relay/src/auth.mjs';
import { createRelay } from '../relay/src/server.mjs';
import { run, start } from '../relay/src/main.mjs';
import { withMigrationLock } from '../relay/src/schema.mjs';
import { DurableStore, migrateDurable } from '../relay/src/durableStore.mjs';
import { makeDb, makeKeys } from './support/relayKit.ts';

const keys = await makeKeys();
const baseEnv = { AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused', HOST: '127.0.0.1' };
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

async function client(port: number, device: string, kind: 'desktop' | 'phone' = 'desktop') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, {
    headers: { authorization: `Bearer ${await keys.sign('u1', device, { kind })}` },
  });
  const inbox: any[] = [];
  ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })),
  );
  await new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)));
  await waitFor(() => inbox.some((m) => m.t === 'hello'), 'the hello message');
  return { ws, inbox, closed };
}

test('shutdown answers the frame in flight, closes every socket with 1012, refuses new sockets and raises no offline push', async () => {
  const { db } = await makeDb();
  await migrateDurable(db);
  const pushed: any[] = [];
  const config = loadConfig(baseEnv);
  const relay = createRelay({
    config,
    db,
    verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
    send: async (m: any) => (pushed.push(m), { ok: true }),
    durable: new DurableStore((fn: any) => db.transaction(fn)),
  });
  const port = await relay.listen(0, '127.0.0.1');
  const mac = await client(port, 'mac1');
  const phone = await client(port, 'ph1', 'phone');
  const P = 'p_shutdown1';
  mac.ws.send(JSON.stringify({ t: 'pair.register', pair: P, rid: 'a' }));
  await until(() => mac.inbox.some((m) => m.rid === 'a'));
  phone.ws.send(JSON.stringify({ t: 'pair.join', pair: P, rid: 'b' }));
  await until(() => phone.inbox.some((m) => m.rid === 'b'));
  phone.ws.send(JSON.stringify({ t: 'push.register', platform: 'apns', token: 'tok' }));
  await until(() => phone.inbox.some((m) => m.op === 'push.register'));
  const send = (ctr: number) =>
    mac.ws.send(
      JSON.stringify({
        t: 'frame',
        pair: P,
        dir: 'm2p',
        ctr,
        nonce: Buffer.alloc(24, 1).toString('base64'),
        box: Buffer.alloc(40, ctr).toString('base64'),
      }),
    );
  // the first frame is answered before the shutdown; the second is in flight when it starts
  send(1);
  await until(() => mac.inbox.some((m) => m.t === 'ack' && m.ctr === 1));
  send(2);
  const down = relay.shutdown({ graceMs: 5000 });
  const [macEnd, phoneEnd] = await Promise.all([mac.closed, phone.closed]);
  await down;
  assert.deepEqual(macEnd, { code: 1012, reason: 'restarting' });
  assert.deepEqual(phoneEnd, { code: 1012, reason: 'restarting' });
  const stored = (await db.query('SELECT ctr FROM remote_durable.frames ORDER BY ctr')).rows.map((r: any) => Number(r.ctr));
  const acked = mac.inbox.filter((m) => m.t === 'ack').map((m) => m.ctr);
  assert.ok(stored.includes(1) && acked.includes(1), 'the frame answered before the shutdown is stored');
  // the one in flight was either never read (its sender resends it) or stored and answered: never one without the other
  assert.deepEqual(stored, acked);
  assert.equal(pushed.length, 0, 'the relay going away is not the Mac going away');
  await assert.rejects(client(port, 'mac2'));
});

test('an upgrade that arrives while the relay is shutting down is answered 503', async () => {
  const { db } = await makeDb();
  const config = loadConfig(baseEnv);
  const relay = createRelay({ config, db, verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }), send: null });
  const port = await relay.listen(0, '127.0.0.1');
  relay.hub.draining = true;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { authorization: `Bearer ${await keys.sign('u1', 'm1')}` } });
  const err = await new Promise<Error>((r) => ws.once('error', r));
  assert.match(err.message, /503/);
  await relay.close();
});

const until = async (done: () => boolean) => {
  await waitFor(done, 'the condition').catch(() => {});
  assert.ok(done(), 'condition not reached');
};

test('start() migrates under the lock; SIGTERM runs the shutdown once and the process is ended if it hangs', async () => {
  const { db } = await makeDb();
  const queries: string[] = [];
  const query = db.query.bind(db);
  db.query = (sql: string, ...rest: unknown[]) => (queries.push(sql.slice(0, 40)), query(sql, ...rest));
  const logs: string[] = [];
  const out = mock.method(console, 'log', (line: string) => logs.push(line));
  const err = mock.method(console, 'error', () => {});
  const proc = Object.assign(new EventEmitter(), { exit: mock.fn() }) as any;
  try {
    const started = await run({ ...baseEnv, PORT: String(await freePort()) }, { pool: db as any, process: proc });
    assert.ok(started);
    // migrations run on a session that holds the lock, has no statement timeout, and gives both back
    const at = (re: RegExp) => queries.findIndex((q) => re.test(q));
    assert.ok(at(/SET statement_timeout = 0/) < at(/pg_advisory_lock/) && at(/pg_advisory_lock/) < at(/CREATE TABLE/));
    assert.ok(at(/pg_advisory_unlock/) > at(/CREATE TABLE/) && at(/RESET statement_timeout/) > at(/pg_advisory_unlock/));
    const port = started!.port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { authorization: `Bearer ${await keys.sign('u1', 'macS')}` } });
    const ended = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    await new Promise((r) => ws.once('message', r));
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    assert.equal(await ended, 1012);
    await until(() => logs.some((l) => /"event":"stopped"/.test(l)));
    assert.equal(logs.filter((l) => /"event":"shutdown"/.test(l)).length, 1, 'a second signal does not start a second shutdown');
    assert.equal(proc.exit.mock.callCount(), 0);
  } finally {
    out.mock.restore();
    err.mock.restore();
  }
});

test('a shutdown that fails ends the process with the reason; a pool the relay opened is closed with it', async () => {
  const { db } = await makeDb();
  const errors: string[] = [];
  const err = mock.method(console, 'error', (line: string) => errors.push(line));
  const out = mock.method(console, 'log', () => {});
  const proc = Object.assign(new EventEmitter(), { exit: mock.fn() }) as any;
  try {
    const started = await run({ ...baseEnv, PORT: String(await freePort()) }, { pool: db as any, process: proc });
    started!.relay.shutdown = async () => {
      throw new Error('hung');
    };
    proc.emit('SIGTERM');
    await until(() => proc.exit.mock.callCount() === 1);
    assert.deepEqual(proc.exit.mock.calls[0].arguments, [1]);
    assert.match(errors.at(-1)!, /relay: shutdown failed: hung/);
    await started!.relay.close();

    // a pool the relay made itself is ended by shutdown(); one it was given is left to its owner
    let ended = 0;
    const opened = await start(
      { ...baseEnv, PORT: String(await freePort()) },
      {
        importPg: async () => ({
          default: {
            Pool: function Pool() {
              return Object.assign(db, { end: async () => void ended++ });
            },
          },
        }),
      },
    );
    await opened.shutdown({ graceMs: 100 });
    assert.equal(ended, 1);
    const borrowed = await start({ ...baseEnv, PORT: String(await freePort()) }, { pool: db as any });
    await borrowed.shutdown();
    assert.equal(ended, 1);
  } finally {
    out.mock.restore();
    err.mock.restore();
  }
});

test('the migration lock is held around the work and released when the work fails or the unlock fails', async () => {
  const calls: string[] = [];
  const session = (fail = false) => ({
    query: async (sql: string) => {
      calls.push(sql.slice(0, 24));
      if (fail && /unlock/.test(sql)) throw new Error('connection lost');
      return { rows: [] };
    },
    release: (e?: Error) => calls.push(e ? `release(${e.message})` : 'release'),
  });
  await withMigrationLock({ connect: async () => session() }, async (conn) => void (await conn.query('CREATE TABLE x')));
  assert.deepEqual(calls, [
    'SET statement_timeout = ',
    'SELECT pg_advisory_lock(',
    'CREATE TABLE x',
    'SELECT pg_advisory_unloc',
    'RESET statement_timeout',
    'release',
  ]);
  calls.length = 0;
  await assert.rejects(
    withMigrationLock({ connect: async () => session() }, async () => {
      throw new Error('bad ddl');
    }),
    /bad ddl/,
  );
  assert.deepEqual(calls, [
    'SET statement_timeout = ',
    'SELECT pg_advisory_lock(',
    'SELECT pg_advisory_unloc',
    'RESET statement_timeout',
    'release',
  ]);
  calls.length = 0;
  await assert.rejects(
    withMigrationLock({ connect: async () => session(true) }, async () => undefined),
    /connection lost/,
  );
  assert.deepEqual(calls, ['SET statement_timeout = ', 'SELECT pg_advisory_lock(', 'SELECT pg_advisory_unloc', 'release(connection lost)']);
  // a lock that cannot be taken still gives the connection back
  calls.length = 0;
  const refusing = {
    query: async (sql: string) => (/advisory_lock/.test(sql) ? Promise.reject(new Error('canceling statement')) : { rows: [] }),
    release: () => calls.push('release'),
  };
  await assert.rejects(
    withMigrationLock({ connect: async () => refusing }, async () => void calls.push('work')),
    /canceling statement/,
  );
  assert.deepEqual(calls, ['release']);
  // a database without connections of its own (the in-process one) is used directly
  const direct: string[] = [];
  await withMigrationLock({ query: async (sql: string) => void direct.push(sql.slice(0, 24)) }, async () => undefined);
  assert.deepEqual(direct, ['SET statement_timeout = ', 'SELECT pg_advisory_lock(', 'SELECT pg_advisory_unloc', 'RESET statement_timeout']);
});

test('a shutdown that never finishes is cut off by the watchdog after the grace period and a little more', async () => {
  const { db } = await makeDb();
  mock.timers.enable({ apis: ['setTimeout'] });
  const out = mock.method(console, 'log', () => {});
  const proc = Object.assign(new EventEmitter(), { exit: mock.fn() }) as any;
  try {
    const started = await run({ ...baseEnv, PORT: String(await freePort()), SHUTDOWN_SECONDS: '5' }, { pool: db as any, process: proc });
    started!.relay.shutdown = () => new Promise(() => undefined);
    proc.emit('SIGTERM');
    mock.timers.tick(5000 + 2999);
    assert.equal(proc.exit.mock.callCount(), 0);
    mock.timers.tick(1);
    assert.deepEqual(
      proc.exit.mock.calls.map((c: any) => c.arguments),
      [[1]],
    );
    mock.timers.reset();
    await started!.relay.close();
  } finally {
    mock.timers.reset();
    out.mock.restore();
  }
});
