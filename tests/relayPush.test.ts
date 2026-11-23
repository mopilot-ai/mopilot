// relay/src/push.mjs: the token registry, the path from a Mac's clear push request to one provider send (fixed title, empty body, merged), and the push-proxy forward.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PushService, proxySender } from '../relay/src/push.mjs';
import { Store } from '../relay/src/store.mjs';
import { makeClock, makeDb } from './support/relayKit.ts';
import { TITLES } from '../relay/src/notifier.mjs';

const { db, reset } = await makeDb();
const store = new Store(db as any);
const clock = makeClock();
beforeEach(reset);

function rig(result: any = { ok: true }) {
  const sent: any[] = [];
  const push = new PushService({
    store,
    send: async (m: any) => (sent.push(m), typeof result === 'function' ? result(m) : result),
    now: clock.now,
  });
  return { push, sent };
}
const pair = { pairId: 'p_pair00001', phoneDeviceId: 'ph1' };

test('without a send path push is disabled; with one it is enabled', async () => {
  const off = new PushService({ store, send: null });
  assert.equal(off.enabled, false);
  assert.equal(await off.request(pair, 'done', 'c1'), 'disabled');
  assert.equal(rig().push.enabled, true);
  assert.equal(typeof new PushService({ store, send: null, now: undefined }).now, 'function');
});

test('no token, no push; a registered token gets the fixed title, an empty body and a hashed collapse id', async () => {
  const { push, sent } = rig();
  assert.equal(await push.request(pair, 'needsYou', 'chat-secret-1'), 'no_token');
  await push.register({ deviceId: 'ph1', userId: 'u1', platform: 'apns', token: 'tok1' });
  assert.equal(await push.request(pair, 'needsYou', 'chat-secret-1'), 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].platform, 'apns');
  assert.equal(sent[0].token, 'tok1');
  assert.equal(sent[0].title, TITLES.needsYou);
  assert.equal(sent[0].ref, 'chat-secret-1');
  assert.match(sent[0].collapseId, /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(sent[0].collapseId).includes('secret'));
  assert.ok(!('body' in sent[0]) || sent[0].body === '');
});

test('two chats within a minute merge: the second carries "(2)" and one shared collapse id; a held "needs you" suppresses "done"', async () => {
  const { push, sent } = rig();
  await push.register({ deviceId: 'ph1', userId: 'u1', platform: 'fcm', token: 'tok1' });
  await push.request(pair, 'done', 'a');
  clock.advance(1000);
  await push.request(pair, 'done', 'b');
  assert.equal(sent[1].title, `${TITLES.done} (2)`);
  assert.equal(sent[1].count, 2);
  assert.equal(sent[1].collapseId, 'merged:done');
  await push.request(pair, 'needsYou', 'c');
  assert.equal(await push.request(pair, 'done', 'c'), 'suppressed');
  assert.equal(sent.length, 3);
  // the same handle on another pair is another chat
  assert.equal(await push.request({ pairId: 'p_pair00002', phoneDeviceId: 'ph1' }, 'done', 'c'), 'sent');
});

test('a failed send says failed; a dead token is forgotten', async () => {
  const bad = rig({ ok: false });
  await bad.push.register({ deviceId: 'ph1', userId: 'u1', platform: 'apns', token: 'tok1' });
  assert.equal(await bad.push.request(pair, 'done', 'a'), 'failed');
  assert.deepEqual(await store.pushTokenOf('ph1'), { platform: 'apns', token: 'tok1' });
  const dead = rig({ ok: false, invalidToken: true });
  await dead.push.register({ deviceId: 'ph1', userId: 'u1', platform: 'apns', token: 'tok1' });
  assert.equal(await dead.push.request(pair, 'done', 'b'), 'failed');
  assert.equal(await store.pushTokenOf('ph1'), null);
  assert.equal(dead.push.notifiers.has('ph1'), false);
});

test('unregister forgets the token; prune drops idle notifiers and keeps busy ones', async () => {
  const { push } = rig();
  await push.register({ deviceId: 'ph1', userId: 'u1', platform: 'apns', token: 't' });
  await push.request(pair, 'done', 'a');
  push.prune(clock.now());
  assert.equal(push.notifiers.size, 1);
  push.prune(clock.now() + 11 * 60_000);
  assert.equal(push.notifiers.size, 0);
  await push.unregister('ph1');
  assert.equal(await store.pushTokenOf('ph1'), null);
});

test('the proxy gets {token, platform, kind, count, collapseId} and never a chat handle or a title', async () => {
  const calls: any[] = [];
  const f = async (url: string, init: any) => (calls.push([url, init]), { ok: true, status: 200, headers: new Headers() });
  const send = proxySender({ url: 'https://push.example/v1', authToken: 'secret', fetch: f as any });
  const out = await send({ platform: 'apns', token: 'T', kind: 'done', title: 'x', count: 2, collapseId: 'cid', ref: 'chat-ref' });
  assert.equal(out.ok, true);
  assert.equal(out.invalidToken, false);
  assert.equal(out.retry, false);
  assert.equal(calls[0][0], 'https://push.example/v1');
  assert.equal(calls[0][1].headers.authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(calls[0][1].body), { token: 'T', platform: 'apns', kind: 'done', count: 2, collapseId: 'cid' });
  await send({ platform: 'apns', token: 'T', kind: 'done', title: 'x', count: 1, collapseId: 'cid', ref: 'r', sealed: 'SEALED' });
  assert.equal(JSON.parse(calls[1][1].body).sealed, 'SEALED');
  const anon = proxySender({ url: 'u', fetch: f as any });
  await anon({ platform: 'fcm', token: 'T', kind: 'done', title: 'x', count: 1, collapseId: 'c', ref: 'r' });
  assert.equal(calls[2][1].headers.authorization, undefined);
});

test('the proxy maps 404/410 to a dead token and a network error to a plain failure', async () => {
  const msg = { platform: 'apns' as const, token: 'T', kind: 'done', title: 'x', count: 1, collapseId: 'c', ref: 'r' };
  for (const status of [404, 410])
    assert.deepEqual(await proxySender({ url: 'u', fetch: (async () => ({ ok: false, status, headers: new Headers() })) as any })(msg), {
      ok: false,
      invalidToken: true,
      retry: false,
      retryAfterMs: undefined,
      fault: false,
    });
  const busy = await proxySender({
    url: 'u',
    fetch: (async () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '2' }) })) as any,
  })(msg);
  assert.deepEqual(busy, { ok: false, invalidToken: false, retry: true, retryAfterMs: 2000, fault: false });
  assert.equal(
    (await proxySender({ url: 'u', fetch: (async () => ({ ok: false, status: 500, headers: new Headers() })) as any })(msg)).retry,
    true,
  );
  assert.deepEqual(
    await proxySender({
      url: 'u',
      fetch: (async () => {
        throw new Error('down');
      }) as any,
    })(msg),
    { ok: false, retry: true, fault: true },
  );
  // the default fetch is the platform's
  const prev = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200, headers: new Headers() })) as any;
  try {
    assert.equal((await proxySender({ url: 'u' })(msg)).ok, true);
  } finally {
    globalThis.fetch = prev;
  }
});

test('every push request is logged with what the provider answered, and never a token, chat handle or text (#4591)', async () => {
  const lines: any[] = [];
  const push = new PushService({
    store,
    send: async (m: any) => (m.ref === 'bad' ? { ok: false, status: 400, reason: 'PayloadTooLarge' } : { ok: true }),
    now: clock.now,
    log: (event: string, data: object) => lines.push(JSON.parse(JSON.stringify({ event, ...data }))),
  });
  await push.register({ deviceId: 'ph1', userId: 'u1', platform: 'apns', token: 'tok-secret' });
  await push.request(pair, 'needsYou', 'bad');
  clock.advance(120_000);
  await push.request(pair, 'needsYou', 'good');
  assert.deepEqual(
    lines.filter((l) => l.event === 'push'),
    [
      { event: 'push', kind: 'needsYou', provider: 'apns', outcome: 'failed', apns: 400, reason: 'PayloadTooLarge' },
      { event: 'push', kind: 'needsYou', provider: 'apns', outcome: 'sent' },
    ],
  );
});

test('a token that is registered, replaced or rejected is logged with the device and where it is sent, never the token (#4591)', async () => {
  const lines: any[] = [];
  const push = new PushService({
    store,
    send: async () => ({ ok: false, invalidToken: true, status: 400, reason: 'BadDeviceToken' }),
    now: clock.now,
    log: (event: string, data: object) => lines.push(JSON.parse(JSON.stringify({ event, ...data }))),
    apns: { sandbox: true, topic: 'ai.example.app' },
  });
  await push.register({ deviceId: 'ph1', userId: 'u1', platform: 'apns', token: 'tok-secret-1' });
  await push.register({ deviceId: 'ph1', userId: 'u1', platform: 'apns', token: 'tok-secret-1' });
  await push.register({ deviceId: 'ph1', userId: 'u1', platform: 'apns', token: 'tok-secret-2' });
  assert.equal(await push.request(pair, 'needsYou', 'c1'), 'failed');
  assert.equal(await push.request(pair, 'needsYou', 'c1'), 'no_token');
  const at = clock.now();
  const base = { event: 'push_token', device: 'ph1', provider: 'apns', environment: 'sandbox', topic: 'ai.example.app', at };
  assert.deepEqual(
    lines.filter((l) => l.event === 'push_token').map(({ at: _at, ...l }) => l),
    [
      { ...base, kind: 'registered' },
      { ...base, kind: 'same' },
      { ...base, kind: 'replaced' },
      { ...base, kind: 'rejected', apns: 400, reason: 'BadDeviceToken' },
    ].map(({ at: _at, ...l }) => l),
  );
  assert.ok(!JSON.stringify(lines).includes('secret'));
  // an Android token and a relay with no APNs keys name no environment
  const fcm = new PushService({ store, send: null, now: clock.now, log: (e: string, d: object) => lines.push({ e, ...d }) });
  await fcm.register({ deviceId: 'ph2', userId: 'u1', platform: 'fcm', token: 'f' });
  assert.equal(lines.at(-1).environment, undefined);
});

test('a Host clearing replaces the chat’s waiting notification: its own collapse id, or the merged one it joined', async () => {
  const { push, sent } = rig();
  await push.register({ deviceId: 'ph1', userId: 'u1', platform: 'apns', token: 'tok1' });
  const ask = (kind: string, ref: string) => push.request(pair, kind, ref, undefined as any, undefined as any, true);
  await ask('needsYou', 'a');
  await ask('cleared', 'a');
  assert.equal(sent[1].title, TITLES.cleared);
  assert.equal(sent[1].collapseId, sent[0].collapseId);
  // two chats waiting within a minute: the second goes out merged, under the shared id
  await ask('needsYou', 'b');
  await ask('needsYou', 'c');
  assert.equal(sent[3].collapseId, 'merged:needsYou');
  assert.notEqual(sent[2].collapseId, sent[3].collapseId);
  await ask('cleared', 'c');
  assert.equal(sent[4].collapseId, 'merged:needsYou', 'it replaces the merged notification, not a notification that does not exist');
  await ask('cleared', 'b');
  assert.equal(sent[5].collapseId, sent[2].collapseId);
  assert.ok(
    sent
      .slice(1)
      .filter((m) => m.kind === 'cleared')
      .every((m) => m.title === TITLES.cleared && m.count === 1),
  );
});
