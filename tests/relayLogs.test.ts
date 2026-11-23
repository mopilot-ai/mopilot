// A whole session through the real relay with secrets planted in everything a client sends: nothing the relay writes to its log or console contains one.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import WebSocket from 'ws';
import { run } from '../relay/src/main.mjs';
import { messageOf } from '../relay/src/processGuards.mjs';
import { makeDb, makeKeys } from './support/relayKit.ts';
import { waitFor } from './support/waitFor.ts';

const keys = await makeKeys();
const canary = {
  body: 'CANARY-FRAME-BODY-0123456789',
  nonce: 'CANARY-NONCE-0123456789',
  pushToken: 'CANARY-PUSH-TOKEN',
  sealed: 'CANARY-SEALED-TITLE',
  ref: 'CANARY-CHAT-REF',
  junk: 'CANARY-JUNK-TEXT',
  metrics: 'CANARY-METRICS-TOKEN',
  bearer: 'CANARY-REVOKE-BEARER',
};
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
const b64 = (text: string, size = 64) => Buffer.from(text.padEnd(size, '.')).toString('base64');

test('no secret a client sends reaches the log or the console, whatever happens to it', async () => {
  const { db } = await makeDb();
  // a database that refuses the planted push token with an error quoting it, the way Postgres quotes a value it cannot parse
  const refusing = {
    query: (sql: string, params?: unknown[]) =>
      params?.includes(canary.pushToken)
        ? Promise.reject(Object.assign(new Error(`invalid input syntax for type text: "${canary.pushToken}"`), { code: '22P02' }))
        : db.query(sql, params as any),
    transaction: (fn: any) => db.transaction(fn),
  };
  const lines: string[] = [];
  const say = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  const out = mock.method(console, 'log', say);
  const err = mock.method(console, 'error', say);
  const proc = Object.assign(new (await import('node:events')).EventEmitter(), { exit: mock.fn() }) as any;
  const tokens: string[] = [];
  try {
    const started = await run(
      {
        AUTH_PUBLIC_KEY: keys.publicPem,
        DATABASE_URL: 'postgres://unused',
        HOST: '127.0.0.1',
        PORT: String(await freePort()),
        PUSH_MODE: 'proxy',
        PUSH_PROXY_URL: 'http://127.0.0.1:1/never',
        METRICS_TOKEN: canary.metrics,
      },
      { pool: refusing as any, process: proc },
    );
    const port = started!.port;
    const open = async (user: string, device: string, kind: 'desktop' | 'phone') => {
      const token = await keys.sign(user, device, { kind });
      tokens.push(token);
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { authorization: `Bearer ${token}` } });
      const inbox: any[] = [];
      ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
      ws.on('error', () => undefined);
      await new Promise((resolve) => ws.once('open', resolve));
      await waitFor(() => inbox.some((m) => m.t === 'hello'), 'the hello message');
      return { ws, inbox, token };
    };
    const mac = await open('u1', 'macC', 'desktop');
    const phone = await open('u1', 'phC', 'phone');
    const P = 'p_canarypair1';
    // waits for what the relay answers instead of a fixed time: a loaded runner (coverage, parallel shards) answers late
    const until = async (ok: () => boolean) => {
      await waitFor(ok, 'the relay answer');
    };
    const send = (c: { ws: WebSocket }, m: object | string) => c.ws.send(typeof m === 'string' ? m : JSON.stringify(m));
    send(mac, { t: 'pair.register', pair: P });
    await until(() => mac.inbox.some((m) => m.t === 'ok' && m.op === 'pair.register'));
    send(phone, { t: 'pair.join', pair: P });
    send(phone, { t: 'push.register', platform: 'apns', token: canary.pushToken });
    await until(() => phone.inbox.some((m) => m.t === 'ok' && m.op === 'pair.join'));
    send(mac, { t: 'frame', pair: P, dir: 'm2p', ctr: 1, nonce: b64(canary.nonce, 24), box: b64(canary.body) });
    send(phone, { t: 'frame', pair: P, dir: 'p2m', ctr: 1, nonce: b64(canary.nonce, 24), box: b64(canary.body) });
    send(phone, { t: 'ack', pair: P, dir: 'm2p', ctr: 1 });
    // content-bearing requests that fail in different ways
    send(mac, { t: 'push', pair: P, kind: 'needsYou', ref: canary.ref, sealed: canary.sealed });
    send(mac, { t: 'push', pair: P, kind: 'nonsense', ref: canary.ref });
    send(mac, { t: 'frame', pair: P, dir: 'm2p', ctr: 2, nonce: canary.junk, box: canary.body });
    send(mac, { t: 'frame', pair: P, dir: 'm2p', ctr: 3, nonce: b64(canary.nonce, 24), box: `!!${canary.junk}` });
    send(mac, `{"t":"frame","junk":"${canary.junk}"`);
    send(mac, { t: canary.junk });
    send(mac, { t: 'frame', pair: 'p_otherpair99', dir: 'm2p', ctr: 1, nonce: b64(canary.nonce, 24), box: b64(canary.body) });
    send(phone, { t: 'presence', state: canary.junk });
    const refused = () => new Set(mac.inbox.filter((m) => m.t === 'error').map((m) => m.code));
    await until(
      () =>
        mac.inbox.some((m) => m.t === 'ack' && m.ctr === 1) &&
        phone.inbox.some((m) => m.t === 'ack' && m.ctr === 1) &&
        ['bad_frame', 'bad_message', 'unknown_pair'].every((c) => refused().has(c)),
    );
    // The phone's later frame acknowledgment is also a barrier after its refused token registration.
    assert.ok(mac.inbox.some((m) => m.t === 'ok' && m.op === 'pair.register'));
    assert.ok(phone.inbox.some((m) => m.t === 'ok' && m.op === 'pair.join'));
    assert.ok(!phone.inbox.some((m) => m.op === 'push.register'), 'the refused push.register was not answered ok');
    assert.ok(
      mac.inbox.some((m) => m.t === 'ack' && m.ctr === 1),
      'the first frame was stored and acknowledged',
    );
    const codes = new Set(mac.inbox.filter((m) => m.t === 'error').map((m) => m.code));
    for (const code of ['bad_frame', 'bad_message', 'unknown_pair'])
      assert.ok(codes.has(code), `the junk was refused with ${code} (got ${[...codes]})`);
    // /metrics and the revoke endpoint see tokens too
    const scrape = await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { authorization: `Bearer ${canary.metrics}` } });
    assert.equal(scrape.status, 200);
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/v1/revoke`, { method: 'POST', headers: { authorization: `Bearer ${canary.bearer}` } })).status,
      401,
    );
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { authorization: `Bearer ${canary.metrics}x` } })).status,
      401,
    );
    mac.ws.send(JSON.stringify({ t: 'presence', state: 'online', pad: canary.junk.repeat(30000) }));
    await until(() => mac.ws.readyState === WebSocket.CLOSED);
    phone.ws.terminate();
    await until(() => !started!.relay.hub.conns.has('phC'));
    proc.emit('SIGTERM');
    await waitFor(() => lines.some((l) => /"event":"stopped"/.test(l)), 'the stopped event');
  } finally {
    out.mock.restore();
    err.mock.restore();
  }
  const log = lines.join('\n');
  assert.match(log, /"event":"listening"/);
  assert.match(log, /"event":"connect","device":"macC"/);
  assert.match(
    log,
    /"event":"error".*invalid input syntax for type text: \\"…\\"/,
    'the database error was logged, with its quoted value removed',
  );
  const secrets = [
    ...Object.values(canary),
    ...Object.values(canary).map((v) => Buffer.from(v).toString('base64').slice(0, 20)),
    Buffer.from(canary.body.padEnd(64, '.')).toString('base64'),
    ...tokens,
    ...tokens.map((t) => t.split('.')[1]),
  ];
  for (const secret of secrets)
    assert.equal(log.includes(secret), false, `the log contains ${secret.slice(0, 40)}:\n${log.slice(0, 2000)}`);
});

test('an error line has the message of the error only: a value the database quotes is removed, the length is bounded, an odd thrown value cannot break the log', () => {
  assert.equal(messageOf(new Error('invalid input syntax for type uuid: "CANARY-VALUE"')), 'invalid input syntax for type uuid: "…"');
  assert.equal(
    messageOf(new Error('duplicate key value violates unique constraint "relay_pairs_pkey"')),
    'duplicate key value violates unique constraint "relay_pairs_pkey"',
  );
  assert.equal(messageOf(new Error('x'.repeat(500))).length, 200);
  assert.equal(messageOf('plain text'), 'plain text');
  assert.equal(messageOf(Object.create(null)), 'unprintable error');
});
