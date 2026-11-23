// The relay at its network edge against a client that misbehaves: a message over the size limit, a box over its limit, a client that stops answering pings, and the connection caps answered with a close code the client can read.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { loadConfig } from '../relay/src/config.mjs';
import { createVerifier } from '../relay/src/auth.mjs';
import { createRelay } from '../relay/src/server.mjs';
import { migrateDurable, DurableStore } from '../relay/src/durableStore.mjs';
import { makeDb, makeKeys } from './support/relayKit.ts';
import { waitFor } from './support/waitFor.ts';

const keys = await makeKeys();
const { db } = await makeDb();
await migrateDurable(db);
const env = { AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused', MAX_CONNECTIONS_PER_ACCOUNT: '2', MAX_CONNECTIONS: '4' };
const config = loadConfig(env);
const relay = createRelay({
  config: { ...config, pingMs: 30 },
  db: db as any,
  verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
  send: null,
  durable: new DurableStore((fn: any) => db.transaction(fn)),
});
const port = await relay.listen(0, '127.0.0.1');
after(() => relay.close());

async function open(user: string, device: string, kind: 'desktop' | 'phone' = 'desktop', options: object = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, {
    headers: { authorization: `Bearer ${await keys.sign(user, device, { kind })}` },
    ...options,
  });
  const inbox: any[] = [];
  ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  await new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)));
  await waitFor(() => inbox.some((m) => m.t === 'hello'), 'the hello frame');
  return { ws, inbox, closed };
}

test('a message over the size limit closes the socket (1009) before it is parsed; a box over its own limit is refused and the socket stays', async () => {
  const mac = await open('u1', 'mac1');
  mac.ws.send(JSON.stringify({ t: 'presence', state: 'online', pad: 'x'.repeat(500 * 1024) }));
  assert.equal(await mac.closed, 1009);

  const phone = await open('u1', 'ph1', 'phone');
  const box = Buffer.alloc(270 * 1024, 1).toString('base64');
  assert.ok(box.length < 400 * 1024, 'the message itself is under the message limit');
  phone.ws.send(
    JSON.stringify({ t: 'frame', pair: 'p_sizecheck1', dir: 'p2m', ctr: 1, nonce: Buffer.alloc(24).toString('base64'), box, rid: 'big' }),
  );
  await waitFor(() => phone.inbox.some((m) => m.rid === 'big'), 'the reply to the big frame');
  assert.deepEqual(
    phone.inbox.find((m) => m.rid === 'big'),
    { t: 'error', code: 'bad_frame', rid: 'big', pair: 'p_sizecheck1' },
  );
  assert.equal(phone.ws.readyState, WebSocket.OPEN);
  phone.ws.close();
});

test('a client that never answers pings is ended after three, and one that answers is not', async () => {
  const mute = await open('u2', 'mac2', 'desktop', { autoPong: false });
  const lively = await open('u2', 'mac3');
  assert.equal(await mute.closed, 1006);
  assert.equal(relay.hub.conns.has('mac2'), false);
  assert.equal(relay.hub.conns.has('mac3'), true, 'the one that answers is still here');
  assert.equal(lively.ws.readyState, WebSocket.OPEN);
  lively.ws.close();
});

test('an account at its device limit is closed 4429 and a full relay 4503, neither reaching the hub, and a device that already has a socket may replace it', async () => {
  await waitFor(() => !relay.hub.all.size, 'the hub to empty');
  const a = await open('u3', 'd1');
  const b = await open('u3', 'd2', 'phone');
  const refused = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { authorization: `Bearer ${await keys.sign('u3', 'd3')}` } });
  assert.deepEqual(await new Promise((resolve) => refused.once('close', (code, reason) => resolve([code, String(reason)]))), [
    4429,
    'account_limit',
  ]);
  assert.equal(relay.hub.all.size, 2, 'the refused socket never reached the hub');
  const replacement = await open('u3', 'd1');
  assert.equal(await a.closed, 4000);
  // two more accounts fill the relay (limit 4: d1, d2, and these two)
  const c = await open('u4', 'e1');
  const d = await open('u5', 'e2');
  const full = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { authorization: `Bearer ${await keys.sign('u6', 'e3')}` } });
  assert.deepEqual(await new Promise((resolve) => full.once('close', (code, reason) => resolve([code, String(reason)]))), [
    4503,
    'capacity',
  ]);
  const counted = relay.metrics.render();
  assert.match(counted, /^relay_connections_refused_total\{reason="account_limit"\} 1$/m);
  assert.match(counted, /^relay_connections_refused_total\{reason="busy"\} 1$/m);
  for (const x of [b, c, d, replacement]) x.ws.close();
  await waitFor(() => !relay.hub.conns.size, 'the connections to close');
});
