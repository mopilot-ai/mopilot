// The relay's operations surface: /healthz and /readyz tell a supervisor whether to restart it or send it traffic, /metrics (Prometheus text, off unless a token is set) counts what happened, and the Metrics text format.
import { waitFor } from './support/waitFor.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { loadConfig } from '../relay/src/config.mjs';
import { createVerifier } from '../relay/src/auth.mjs';
import { createRelay } from '../relay/src/server.mjs';
import { Metrics } from '../relay/src/metrics.mjs';
import { migrateDurable, DurableStore } from '../relay/src/durableStore.mjs';
import { makeDb, makeKeys } from './support/relayKit.ts';

const keys = await makeKeys();
const { db } = await makeDb();
await migrateDurable(db);
const env = { AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused' };

async function serve(o: { token?: string; database?: any; healthMs?: number; durable?: boolean; now?: () => number } = {}) {
  const config = loadConfig({
    ...env,
    ...(o.token && { METRICS_TOKEN: o.token }),
    ...(o.healthMs && { HEALTH_DB_TIMEOUT_MS: String(o.healthMs) }),
  });
  const relay = createRelay({
    config,
    db: o.database ?? (db as any),
    verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
    send: async () => ({ ok: true }),
    ...(o.now && { now: o.now }),
    durable: o.durable === false ? null : new DurableStore((fn: any) => db.transaction(fn)),
  });
  const port = await relay.listen(0, '127.0.0.1');
  return { relay, base: `http://127.0.0.1:${port}`, port };
}

test('the Metrics text: HELP and TYPE lines, sorted series, labels escaped, counters added to, gauges replaced', () => {
  const m = new Metrics();
  m.inc('b_total', { code: 'x' }, 1, 'Things');
  m.inc('b_total', { code: 'x' });
  m.inc('b_total', { code: 'quote"\\\nline' });
  m.set('a_gauge', 5, {}, 'A gauge');
  m.set('a_gauge', 7);
  m.set('c_gauge', Number.NaN, { k: 1 });
  assert.equal(
    m.render(),
    [
      '# HELP a_gauge A gauge',
      '# TYPE a_gauge gauge',
      'a_gauge 7',
      '# HELP b_total Things',
      '# TYPE b_total counter',
      'b_total{code="x"} 2',
      'b_total{code="quote\\"\\\\\\nline"} 1',
      '# HELP c_gauge c_gauge',
      '# TYPE c_gauge gauge',
      'c_gauge{k="1"} 0',
      '',
    ].join('\n'),
  );
  assert.equal(new Metrics().render(), '\n');
});

test('/healthz and /readyz answer ok; a database that errors or hangs is down; a draining relay is alive but not ready', async () => {
  const { relay, base } = await serve();
  assert.equal(await (await fetch(`${base}/healthz`)).text(), 'ok');
  assert.equal(await (await fetch(`${base}/readyz`)).text(), 'ready');
  relay.hub.draining = true;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const draining = await fetch(`${base}/readyz`);
  assert.deepEqual([draining.status, await draining.text()], [503, 'draining']);
  await relay.close();

  const broken = await serve({ database: { query: async () => Promise.reject(new Error('connection refused')) } });
  assert.deepEqual([(await fetch(`${broken.base}/healthz`)).status, (await fetch(`${broken.base}/readyz`)).status], [503, 503]);
  await broken.relay.close();

  const hung = await serve({ database: { query: () => new Promise(() => undefined) }, healthMs: 50 });
  const res = await fetch(`${hung.base}/readyz`);
  assert.deepEqual([res.status, await res.text()], [503, 'database unavailable']);
  await hung.relay.close();
});

test('/metrics is off without a token, needs the bearer token with one, and counts connections, frames, errors, pushes and closes', async () => {
  const off = await serve();
  assert.equal((await fetch(`${off.base}/metrics`)).status, 404);
  await off.relay.close();

  const { relay, base, port } = await serve({ token: 'scrape-secret' });
  assert.equal((await fetch(`${base}/metrics`)).status, 401);
  assert.equal((await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer wrong-secret!' } })).status, 401);
  assert.equal((await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer scrape-secret-longer' } })).status, 401);
  const open = async (user: string, device: string, kind: 'desktop' | 'phone') => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, {
      headers: { authorization: `Bearer ${await keys.sign(user, device, { kind })}` },
    });
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
    await new Promise((resolve) => ws.once('open', resolve));
    await waitFor(() => inbox.some((m) => m.t === 'hello'), 'the hello message');
    return { ws, inbox };
  };
  const mac = await open('u1', 'mac1', 'desktop');
  const phone = await open('u1', 'ph1', 'phone');
  mac.ws.send(JSON.stringify({ t: 'pair.register', pair: 'p_metrics001' }));
  await waitFor(() => mac.inbox.some((m) => m.t === 'ok' && m.op === 'pair.register'), 'the metrics pair registration');
  phone.ws.send(JSON.stringify({ t: 'pair.join', pair: 'p_metrics001' }));
  phone.ws.send(JSON.stringify({ t: 'push.register', platform: 'apns', token: 'tok' }));
  await waitFor(() => phone.inbox.some((m) => m.t === 'ok' && m.op === 'push.register'), 'the phone joining and registering its token');
  const frame = {
    t: 'frame',
    pair: 'p_metrics001',
    dir: 'm2p',
    ctr: 1,
    nonce: Buffer.alloc(24, 1).toString('base64'),
    box: Buffer.alloc(40, 2).toString('base64'),
  };
  mac.ws.send(JSON.stringify(frame));
  mac.ws.send(JSON.stringify({ ...frame, dir: 'p2m', ctr: 2 }));
  mac.ws.send(JSON.stringify({ t: 'push', pair: 'p_metrics001', kind: 'needsYou', ref: 'chat-1' }));
  await waitFor(
    () =>
      mac.inbox.some((m) => m.t === 'ack' && m.ctr === 1) &&
      mac.inbox.some((m) => m.t === 'error' && m.code === 'bad_dir') &&
      mac.inbox.some((m) => m.t === 'push.result' && m.status === 'sent'),
    'the frame, rejected direction and completed push',
  );
  const scrape = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer scrape-secret' } });
  assert.equal(scrape.status, 200);
  assert.match(scrape.headers.get('content-type')!, /^text\/plain/);
  const text = await scrape.text();
  for (const line of [
    'relay_connections{kind="desktop"} 1',
    'relay_connections{kind="phone"} 1',
    'relay_draining 0',
    'relay_pairs{state="joined"} 1',
    'relay_mailbox_frames 1',
    'relay_database_up 1',
    'relay_frames_total{dir="m2p",via="mailbox"} 1',
    'relay_errors_total{code="bad_dir"} 1',
    'relay_push_requests_total{kind="needsYou",status="sent"} 1',
  ])
    assert.ok(text.split('\n').includes(line), `missing: ${line}\n${text}`);
  for (const name of [
    'relay_uptime_seconds',
    'relay_event_loop_lag_seconds',
    'process_resident_memory_bytes',
    'process_heap_used_bytes',
    'process_external_memory_bytes',
    'process_cpu_seconds_total',
    'relay_mailbox_bytes',
  ])
    assert.match(text, new RegExp(`^${name} [0-9.e+-]+$`, 'm'));
  mac.ws.close();
  await waitFor(() => !relay.hub.conns.has('mac1'), 'the desktop connection closing');
  const after1 = await (await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer scrape-secret' } })).text();
  assert.match(after1, /relay_closes_total\{code="1005"\} 1/);
  assert.match(after1, /relay_connections\{kind="desktop"\} 0/);
  phone.ws.close();
  await relay.close();
});

test('a database that fails during a scrape still answers, with relay_database_up 0', async () => {
  const flaky = {
    query: async (sql: string, p?: unknown[]) =>
      /FROM relay_pairs/.test(sql) ? Promise.reject(new Error('down')) : db.query(sql, p as any),
  };
  const { relay, base } = await serve({ token: 't', database: flaky });
  const text = await (await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer t' } })).text();
  assert.match(text, /^relay_database_up 0$/m);
  assert.doesNotMatch(text, /relay_pairs\{/);
  await relay.close();
});

test('a flood of health checks costs the database one query, and the answer is reused for a second', async () => {
  let queries = 0;
  const counting = {
    query: async (sql: string, p?: unknown[]) => (/^SELECT 1$/.test(sql) ? (queries++, db.query(sql, p as any)) : db.query(sql, p as any)),
  };
  const { relay, base } = await serve({ database: counting });
  const answers = await Promise.all(
    Array.from({ length: 40 }, (_, i) => fetch(`${base}${i % 2 ? '/healthz' : '/readyz'}`).then((r) => r.status)),
  );
  assert.deepEqual(new Set(answers), new Set([200]));
  assert.equal(queries, 1, 'forty requests at once, one query');
  await fetch(`${base}/healthz`);
  assert.equal(queries, 1, 'and none for the next second');
  await relay.close();
});

test('a relay without the durable mailbox reports no stored frames, and a draining one says so in /metrics', async () => {
  const { relay, base } = await serve({ token: 't', durable: false });
  relay.hub.draining = true;
  const text = await (await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer t' } })).text();
  assert.match(text, /^relay_draining 1$/m);
  assert.match(text, /^relay_mailbox_frames 0$/m);
  assert.match(text, /^relay_mailbox_bytes 0$/m);
  await db.query(
    "INSERT INTO relay_pairs (pair_id, user_id, mac_device_id, phone_device_id, join_deadline, created_at) VALUES ('p_plainmbox1', 'u', 'm', 'p', now(), now())",
  );
  await db.query(
    "INSERT INTO relay_mailbox (pair_id, dir, ctr, nonce, box, size, created_at, expires_at) VALUES ('p_plainmbox1', 'm2p', 0, '\\x01', '\\x0203', 2, now(), now() + interval '1 day')",
  );
  const other = await serve({ token: 't', durable: false });
  const counted = await (await fetch(`${other.base}/metrics`, { headers: { authorization: 'Bearer t' } })).text();
  assert.match(counted, /^relay_mailbox_frames 1$/m, 'the plain mailbox is counted when the durable one is off');
  assert.match(counted, /^relay_mailbox_bytes 2$/m);
  await db.query('DELETE FROM relay_pairs');
  await other.relay.close();
  await relay.close();
});

test('a whitespace token leaves /metrics off, and what a database that stops answering leaves behind is the unknown, not the old numbers', async () => {
  const blank = await serve({ token: '   ' });
  assert.equal((await fetch(`${blank.base}/metrics`)).status, 404);
  await blank.relay.close();
  let failing = false;
  const flaky = {
    query: async (sql: string, p?: unknown[]) =>
      failing && /FROM relay_pairs/.test(sql) ? Promise.reject(new Error('down')) : db.query(sql, p as any),
  };
  let clock = Date.now();
  const { relay, base } = await serve({ token: 't', database: flaky, now: () => clock });
  const first = await (await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer t' } })).text();
  assert.match(first, /^relay_pairs\{state="joined"\} 0$/m);
  failing = true;
  // the counts are kept for 10 s: scrape again after that
  clock += 11_000;
  const second = await (await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer t' } })).text();
  assert.match(second, /^relay_database_up 0$/m);
  assert.doesNotMatch(second, /^(relay_pairs|relay_mailbox_frames|relay_mailbox_bytes|relay_account_mailbox_bytes_max)[ {]/m);
  await relay.close();
});

test('a close code a client chose is counted as other, and a replaced socket is counted too', async () => {
  const { relay, base, port } = await serve({ token: 't' });
  const open = async (device: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { authorization: `Bearer ${await keys.sign('u9', device)}` } });
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
    await new Promise((resolve) => ws.once('open', resolve));
    await waitFor(() => inbox.some((m) => m.t === 'hello'), 'the connection hello');
    return ws;
  };
  const a = await open('dA');
  a.close(4999, 'mine');
  await waitFor(() => /^relay_closes_total\{code="other"\} 1$/m.test(relay.hub.metrics.render()), 'the custom close being counted');
  const b = await open('dB');
  const b2 = await open('dB');
  await waitFor(() => /^relay_closes_total\{code="4000"\} 1$/m.test(relay.hub.metrics.render()), 'the replaced socket closing');
  const text = await (await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer t' } })).text();
  assert.match(text, /^relay_closes_total\{code="other"\} 1$/m);
  assert.match(text, /^relay_closes_total\{code="4000"\} 1$/m, 'the socket the relay replaced');
  assert.doesNotMatch(text, /code="4999"/);
  b.close();
  b2.close();
  await relay.close();
});

test('a repeated frame is not counted twice', async () => {
  const { relay, base, port } = await serve({ token: 't' });
  const open = async (device: string, kind: 'desktop' | 'phone') => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, {
      headers: { authorization: `Bearer ${await keys.sign('u8', device, { kind })}` },
    });
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
    await new Promise((resolve) => ws.once('open', resolve));
    await waitFor(() => inbox.some((m) => m.t === 'hello'), 'the duplicate-frame connection hello');
    return { ws, inbox };
  };
  const mac = await open('mA', 'desktop');
  const phone = await open('pA', 'phone');
  mac.ws.send(JSON.stringify({ t: 'pair.register', pair: 'p_dupmetric01' }));
  await waitFor(() => mac.inbox.some((m) => m.t === 'ok' && m.op === 'pair.register'), 'the duplicate-frame pair registration');
  phone.ws.send(JSON.stringify({ t: 'pair.join', pair: 'p_dupmetric01' }));
  await waitFor(() => phone.inbox.some((m) => m.t === 'ok' && m.op === 'pair.join'), 'the duplicate-frame phone joining');
  const frame = JSON.stringify({
    t: 'frame',
    pair: 'p_dupmetric01',
    dir: 'm2p',
    ctr: 1,
    nonce: Buffer.alloc(24, 1).toString('base64'),
    box: Buffer.alloc(40, 2).toString('base64'),
  });
  mac.ws.send(frame);
  mac.ws.send(frame);
  await waitFor(() => mac.inbox.filter((m) => m.t === 'ack' && m.ctr === 1).length === 2, 'both duplicate frame acknowledgments');
  const text = await (await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer t' } })).text();
  assert.match(text, /^relay_frames_total\{dir="m2p",via="mailbox"\} 1$/m);
  mac.ws.close();
  phone.ws.close();
  await relay.close();
});

after(() => undefined);
