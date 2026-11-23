// Push dispatch under a failing provider: the circuit breaker, the in-flight limit, timeouts, the dry run, and the answers APNs and FCM really give (BadDeviceToken, Unregistered, 429 with Retry-After, 5xx, SENDER_ID_MISMATCH, an invalid grant) mapped to what the relay does with them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { apnsSender } from '../relay/src/apns.mjs';
import { fcmSender } from '../relay/src/fcm.mjs';
import { proxySender } from '../relay/src/push.mjs';
import { CircuitBreaker, withBreaker, withLimit } from '../relay/src/pushGuard.mjs';
import { createSender, dryRunSender } from '../relay/src/pushSenders.mjs';
import { Metrics } from '../relay/src/metrics.mjs';
import { apnsBody, fcmMessage } from '../relay/src/pushPayload.mjs';
import { apns as apnsShape, fcm as fcmShape, scriptedFetch, type Answer } from './support/pushProviderShapes.ts';

const ecPem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const rsaPem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const sa = { client_email: 'svc@proj.iam.gserviceaccount.com', private_key: rsaPem, project_id: 'proj-1' };
const msg = (o: object = {}) => ({
  platform: 'fcm' as const,
  token: 'tok-1',
  kind: 'needsYou',
  title: 'A chat needs you',
  count: 1,
  collapseId: 'c'.repeat(32),
  ref: 'chat-ref',
  ...o,
});
const clock = (start = 1_700_000_000_000) => {
  const c = { t: start, now: () => c.t, advance: (ms: number) => (c.t += ms) };
  return c;
};

test('the breaker opens after a run of failures, lets one probe through after the cool-down, doubles the cool-down when the probe fails and closes when it succeeds', () => {
  const c = clock();
  const b = new CircuitBreaker({ failures: 3, cooldownMs: 1000, maxCooldownMs: 3000, now: c.now });
  assert.equal(b.state, 'closed');
  b.failure();
  b.failure();
  b.success();
  b.failure();
  b.failure();
  assert.equal(b.state, 'closed', 'a success resets the run');
  b.failure();
  assert.deepEqual([b.state, b.allow()], ['open', false]);
  c.advance(999);
  assert.equal(b.allow(), false);
  c.advance(1);
  assert.equal(b.state, 'half-open');
  assert.equal(b.allow(), true, 'the probe');
  assert.deepEqual([b.state, b.allow()], ['open', false], 'only one probe at a time');
  b.failure();
  assert.equal(b.openUntil - c.t, 2000, 'a failed probe doubles the cool-down');
  c.advance(2000);
  assert.equal(b.allow(), true);
  b.failure();
  assert.equal(b.openUntil - c.t, 3000, 'up to the cap');
  c.advance(3000);
  assert.equal(b.allow(), true);
  b.success();
  assert.deepEqual([b.state, b.allow(), b.cooldownMs], ['closed', true, 1000]);
  // failures while open (answers to requests that were already in flight) do not move the deadline
  for (let i = 0; i < 3; i++) b.failure();
  const until = b.openUntil;
  b.failure();
  assert.equal(b.openUntil, until);
});

test("the breaker counts a provider's faults, not a device's dead token, a 429 or a rejected payload, and a throw is a fault", async () => {
  const c = clock();
  const b = new CircuitBreaker({ failures: 2, cooldownMs: 1000, now: c.now });
  const seen: string[] = [];
  const answers: any[] = [
    { ok: false, invalidToken: true },
    { ok: false, invalidToken: true },
    { ok: true },
    { ok: false, retry: true, fault: false },
    { ok: false, retry: false },
    new Error('socket hang up'),
    { ok: false, retry: true, fault: true },
  ];
  let calls = 0;
  const send = withBreaker(
    async () => {
      const a = answers.shift();
      calls++;
      if (a instanceof Error) throw a;
      return a;
    },
    b,
    (outcome) => seen.push(outcome),
  );
  assert.deepEqual(await send(msg()), { ok: false, invalidToken: true });
  for (let i = 0; i < 4; i++) await send(msg());
  assert.equal(b.state, 'closed', 'dead tokens, a success, a 429 and a rejected payload keep it closed');
  await send(msg());
  assert.deepEqual(await send(msg()), { ok: false, retry: true, fault: true });
  assert.equal(b.state, 'open');
  const before = calls;
  assert.deepEqual(await send(msg()), { ok: false, breakerOpen: true });
  assert.equal(calls, before, 'an open breaker does not reach the provider');
  assert.deepEqual(seen, ['invalid_token', 'invalid_token', 'sent', 'rejected', 'rejected', 'failed', 'failed', 'breaker_open']);
});

test('a breaker with no observer still guards, on a monotonic clock by default', async () => {
  const b = new CircuitBreaker({ failures: 1 });
  const send = withBreaker(async () => ({ ok: false, retry: true, fault: true }), b);
  await send(msg());
  assert.deepEqual(await send(msg()), { ok: false, breakerOpen: true });
});

test('the limit runs this many at once, queues the next ones and sheds beyond the queue, and frees its place when a send throws', async () => {
  let running = 0;
  let peak = 0;
  const gates: (() => void)[] = [];
  const send = withLimit(
    async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => gates.push(resolve));
      running--;
      return { ok: true };
    },
    { limit: 2, queue: 2 },
  );
  const all = Array.from({ length: 6 }, () => send(msg()));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(running, 2);
  const shed = (await Promise.all(all.slice(4))).filter((r) => (r as any).shed);
  assert.equal(shed.length, 2, 'two ran, two waited, two were shed');
  while (gates.length) {
    gates.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const results = await Promise.all(all);
  assert.equal(results.filter((r) => r.ok).length, 4);
  assert.equal(peak, 2);
  const throwing = withLimit(async () => Promise.reject(new Error('boom')), { limit: 1, queue: 1 });
  await assert.rejects(throwing(msg()));
  await assert.rejects(throwing(msg()), /boom/, 'the place was given back');
});

test('FCM answers: a dead token is pruned, a rate limit or an outage is retried with the wait it names, anything else is final', async () => {
  const table: [string, Answer, object][] = [
    ['200', fcmShape.ok(), { ok: true }],
    ['404 UNREGISTERED', fcmShape.unregistered(), { ok: false, invalidToken: true }],
    ['404 with no detail', fcmShape.notFoundPlain(), { ok: false, invalidToken: true }],
    ['400 not a valid registration token', fcmShape.invalidToken(), { ok: false, invalidToken: true }],
    ['403 SENDER_ID_MISMATCH', fcmShape.senderIdMismatch(), { ok: false, invalidToken: true }],
    [
      "400 a bad payload is not the token, nor the provider's fault",
      fcmShape.invalidPayload(),
      { ok: false, retry: false, retryAfterMs: undefined, fault: false },
    ],
    [
      "403 the API is disabled: a fault of the relay's credential",
      fcmShape.permissionDenied(),
      { ok: false, retry: false, retryAfterMs: undefined, fault: true },
    ],
    [
      "429 QUOTA_EXCEEDED, Retry-After 30: no fault, it may be one device's rate",
      fcmShape.quotaExceeded('30'),
      { ok: false, retry: true, retryAfterMs: 30_000, fault: false },
    ],
    ['500 INTERNAL', fcmShape.internal(), { ok: false, retry: true, retryAfterMs: undefined, fault: true }],
    ['503 UNAVAILABLE, Retry-After 5', fcmShape.unavailable('5'), { ok: false, retry: true, retryAfterMs: 5000, fault: true }],
  ];
  for (const [name, answer, expected] of table) {
    const { f } = scriptedFetch((url) => (url.includes('token') ? fcmShape.token() : answer));
    assert.deepEqual(await fcmSender({ serviceAccount: sa, fetch: f })(msg()), expected, name);
  }
  // 401: the access token is dropped and the request tried again, which mints a new one
  let minted = 0;
  const { f } = scriptedFetch((url, n) =>
    url.includes('oauth2') ? (minted++, fcmShape.token()) : n <= 2 ? fcmShape.unauthenticated() : fcmShape.ok(),
  );
  const send = fcmSender({ serviceAccount: sa, fetch: f });
  assert.deepEqual(await send(msg()), { ok: false, retry: true, fault: true });
  assert.deepEqual(await send(msg()), { ok: true });
  assert.equal(minted, 2);
  // the token endpoint refusing the service account (a key that was revoked) is a failure for the breaker, not a dead device token
  const { f: refused } = scriptedFetch(() => fcmShape.invalidGrant());
  assert.deepEqual(await fcmSender({ serviceAccount: sa, fetch: refused })(msg()), { ok: false, retry: true, fault: true });
});

// ---- APNs, against a local HTTP/2 server that answers as Apple does ------------------------------------------------
type Step = Answer | 'silence' | 'headers-only' | { delay: number; answer: Answer };
let script: Step[] = [];
const server = http2.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const step = script.shift() ?? apnsShape.ok();
    if (step === 'silence') return;
    if (step === 'headers-only') return void res.writeHead(200, {}), (res as any).flushHeaders();
    const answer = 'answer' in step ? step.answer : step;
    const reply = () => {
      res.writeHead(answer.status, answer.headers ?? {});
      res.end(answer.body ? JSON.stringify(answer.body) : '');
    };
    if ('delay' in step) setTimeout(reply, step.delay).unref();
    else reply();
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const sessions: http2.ClientHttp2Session[] = [];
let connects = 0;
const connect = () => {
  connects++;
  const s = http2.connect(`http://127.0.0.1:${(server.address() as any).port}`);
  sessions.push(s);
  return s;
};
after(() => {
  for (const s of sessions) s.destroy();
  server.close();
});
const apnsOf = (o: object = {}) =>
  apnsSender({ keyPem: ecPem, keyId: 'KEY123', teamId: 'TEAM456', topic: 'ai.example.app', connect, ...o });

test('APNs answers: a dead or foreign token is pruned, a rate limit or an outage is retried, a rejected credential or payload is final', async () => {
  const table: [string, Answer, object][] = [
    ['200', apnsShape.ok(), { ok: true }],
    ['400 BadDeviceToken', apnsShape.badDeviceToken(), { ok: false, invalidToken: true, wrongApp: true }],
    ['400 DeviceTokenNotForTopic', apnsShape.deviceTokenNotForTopic(), { ok: false, invalidToken: true, wrongApp: true }],
    ['410 Unregistered', apnsShape.unregistered(), { ok: false, invalidToken: true }],
    ["400 BadTopic is the relay's configuration", apnsShape.badTopic(), { ok: false, retry: false, retryAfterMs: undefined, fault: false }],
    [
      "403 InvalidProviderToken: the relay's key",
      apnsShape.invalidProviderToken(),
      { ok: false, retry: false, retryAfterMs: undefined, fault: true },
    ],
    ['413 PayloadTooLarge', apnsShape.payloadTooLarge(), { ok: false, retry: false, retryAfterMs: undefined, fault: false }],
    ['429 TooManyRequests, Retry-After 7', apnsShape.tooManyRequests('7'), { ok: false, retry: true, retryAfterMs: 7000, fault: false }],
    ['500 InternalServerError', apnsShape.internalServerError(), { ok: false, retry: true, retryAfterMs: undefined, fault: true }],
    ['503 ServiceUnavailable', apnsShape.serviceUnavailable(), { ok: false, retry: true, retryAfterMs: undefined, fault: true }],
    ['403 ExpiredProviderToken is re-signed and retried', apnsShape.expiredProviderToken(), { ok: false, retry: true }],
  ];
  const send = apnsOf();
  for (const [name, answer, expected] of table) {
    script = [answer];
    // what Apple answered stays with a failure (its status and reason), and a success carries neither
    const { status, reason, ...result } = (await send(msg({ platform: 'apns', token: 'abcdef' }))) as any;
    assert.deepEqual(result, expected, name);
    assert.equal(status !== undefined, !(expected as any).ok, name);
    assert.equal(typeof reason, (expected as any).ok ? 'undefined' : 'string', name);
  }
});

test('a provider that does not answer in time is a retryable failure, for FCM, its token endpoint, the proxy and APNs; APNs drops the session that went silent', async () => {
  const hang = scriptedFetch(() => 'hang');
  assert.deepEqual(
    await fcmSender({ serviceAccount: sa, fetch: hang.f, timeoutMs: 20 })(msg()),
    { ok: false, retry: true, fault: true },
    'the token endpoint hangs',
  );
  const sendHangs = scriptedFetch((url) => (url.includes('oauth2') ? fcmShape.token() : 'hang'));
  assert.deepEqual(
    await fcmSender({ serviceAccount: sa, fetch: sendHangs.f, timeoutMs: 20 })(msg()),
    { ok: false, retry: true, fault: true },
    'messages:send hangs',
  );
  assert.ok(sendHangs.calls.every((c) => c.init.signal instanceof AbortSignal));
  const proxy = scriptedFetch(() => 'hang');
  const out = await proxySender({ url: 'http://proxy.invalid/push', fetch: proxy.f, timeoutMs: 20 })(msg());
  assert.deepEqual(out, { ok: false, retry: true, fault: true });
  const send = apnsOf({ timeoutMs: 40 });
  script = ['silence'];
  const before = connects;
  assert.deepEqual(await send(msg({ platform: 'apns', token: 'aa' })), { ok: false, retry: true, fault: true });
  script = [apnsShape.ok()];
  assert.deepEqual(await send(msg({ platform: 'apns', token: 'aa' })), { ok: true });
  assert.equal(connects, before + 2, 'the session that answered nothing was dropped and the next request opened another');
  assert.deepEqual(await send(msg({ platform: 'apns', token: 'aa' })), { ok: true });
  assert.equal(connects, before + 2, 'a session that works is reused');
});

test('the dry run logs the platform, kind, fixed title and payload size and never a token, a chat handle or a sealed title', async () => {
  const lines: [string, any][] = [];
  const send = dryRunSender((e, d) => lines.push([e, d]));
  const apnsMsg = msg({ platform: 'apns', token: 'SECRET-TOKEN', ref: 'SECRET-REF', sealed: 'SECRET-SEALED' });
  assert.deepEqual(await send(apnsMsg), { ok: true });
  assert.deepEqual(await send(msg({ token: 'SECRET-TOKEN', ref: 'SECRET-REF' })), { ok: true });
  assert.deepEqual(lines[0], [
    'push_dry_run',
    { platform: 'apns', kind: 'needsYou', title: 'A chat needs you', bytes: Buffer.byteLength(JSON.stringify(apnsBody(apnsMsg))) },
  ]);
  assert.deepEqual(lines[1][1], {
    platform: 'fcm',
    kind: 'needsYou',
    title: 'A chat needs you',
    bytes: Buffer.byteLength(JSON.stringify({ message: fcmMessage(msg({ token: 'SECRET-TOKEN', ref: 'SECRET-REF' })) })),
  });
  assert.doesNotMatch(JSON.stringify(lines), /SECRET/);
  assert.ok(lines[0][1].bytes < 4096, 'under the APNs payload limit');
});

const push = (o: object = {}) =>
  ({
    mode: 'direct',
    proxyUrl: '',
    proxyToken: '',
    timeoutMs: 50,
    breakerFailures: 3,
    breakerCooldownMs: 1000,
    maxInFlight: 8,
    apns: null,
    fcm: sa,
    ...o,
  }) as any;

test('through createSender a failing provider is left alone after its run of failures, on its own: the other provider and the probe after the cool-down still work', async () => {
  const c = clock();
  const metrics = new Metrics();
  const logs: [string, any][] = [];
  let healthy = false;
  const { f, calls } = scriptedFetch((url) =>
    url.includes('oauth2') ? fcmShape.token() : healthy ? fcmShape.ok() : fcmShape.unavailable('0'),
  );
  script = [];
  const send = createSender(push({ apns: { keyPem: ecPem, keyId: 'K', teamId: 'T', topic: 'x', sandbox: true } }), {
    fetch: f,
    connect,
    breakerNow: c.now,
    retry: { sleep: async () => undefined },
    log: (e, d) => logs.push([e, d]),
    metrics,
  })!;
  const sends = () => calls.filter((x) => x.url.includes('messages:send')).length;
  // each push is tried three times; the breaker counts the push once, so two failed pushes do not open it
  for (let i = 0; i < 2; i++) assert.deepEqual(await send(msg()), { ok: false, fault: true });
  assert.equal(sends(), 6);
  assert.deepEqual(logs, []);
  assert.deepEqual(await send(msg()), { ok: false, fault: true });
  assert.equal(sends(), 9);
  assert.deepEqual(logs, [['push_breaker_open', { provider: 'fcm' }]]);
  assert.deepEqual(await send(msg()), { ok: false, breakerOpen: true });
  assert.equal(sends(), 9, 'the open breaker kept the fourth push from the provider');
  // APNs has its own breaker
  script = [apnsShape.ok()];
  assert.deepEqual(await send(msg({ platform: 'apns', token: 'aa' })), { ok: true });
  // the cool-down passes: one probe, and its success closes the breaker
  c.advance(1000);
  healthy = true;
  assert.deepEqual(await send(msg()), { ok: true });
  assert.equal(sends(), 10);
  assert.deepEqual(await send(msg()), { ok: true });
  const text = metrics.render();
  assert.match(text, /relay_push_provider_total\{outcome="failed",provider="fcm"\} 3/, 'one per push, not per attempt');
  assert.match(text, /relay_push_provider_total\{outcome="breaker_open",provider="fcm"\} 1/);
  assert.match(text, /relay_push_provider_total\{outcome="sent",provider="fcm"\} 2/);
  assert.match(text, /relay_push_provider_total\{outcome="sent",provider="apns"\} 1/);
  assert.match(text, /relay_push_breaker_open\{provider="fcm"\} 0/);
});

test('createSender: none is null, dryrun needs no keys, a platform without keys is a failure, and the proxy gets the same protection', async () => {
  assert.equal(createSender(push({ mode: 'none' })), null);
  const lines: [string, any][] = [];
  const dry = createSender(push({ mode: 'dryrun', apns: null, fcm: null }), { log: (e, d) => lines.push([e, d]) })!;
  assert.deepEqual(await dry(msg({ platform: 'apns' })), { ok: true });
  assert.equal(lines[0][0], 'push_dry_run');
  const direct = createSender(push({ apns: null }))!;
  assert.deepEqual(await direct(msg({ platform: 'apns' })), { ok: false });
  const { f, calls } = scriptedFetch(() => ({ status: 503 }));
  const proxied = createSender(push({ mode: 'proxy', proxyUrl: 'http://proxy.invalid/p', fcm: null, breakerFailures: 2 }), {
    fetch: f,
    retry: { attempts: 1, sleep: async () => undefined },
  })!;
  await proxied(msg());
  await proxied(msg());
  await proxied(msg());
  assert.equal(calls.length, 2, 'the third request never left');
});

test('the in-flight limit sheds a request with failed when a provider is stalled, and answers the Mac', async () => {
  const metrics = new Metrics();
  const gate = scriptedFetch((url) => (url.includes('oauth2') ? fcmShape.token() : 'hang'));
  const send = createSender(push({ maxInFlight: 1, timeoutMs: 5000, breakerFailures: 1000 }), {
    fetch: gate.f,
    retry: { attempts: 1, sleep: async () => undefined },
    metrics,
  })!;
  const held = Array.from({ length: 205 }, () => send(msg()));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const results = await Promise.race([Promise.all(held.slice(201)), new Promise((resolve) => setTimeout(() => resolve('stuck'), 500))]);
  assert.deepEqual(results, [
    { ok: false, shed: true },
    { ok: false, shed: true },
    { ok: false, shed: true },
    { ok: false, shed: true },
  ]);
  assert.match(metrics.render(), /relay_push_provider_total\{outcome="shed",provider="fcm"\} 4/);
});

test('an APNs request that times out does not take the others on its connection with it: they finish, are retried, or succeed, and new requests use a new connection', async () => {
  const send = apnsOf({ timeoutMs: 120 });
  const before = connects;
  script = ['silence', { delay: 60, answer: apnsShape.ok() }];
  const slow = send(msg({ platform: 'apns', token: 'a1' }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const bystander = send(msg({ platform: 'apns', token: 'a2' }));
  assert.deepEqual(await slow, { ok: false, retry: true, fault: true });
  assert.deepEqual(await bystander, { ok: true }, 'the other request on the same session was not cut');
  script = [apnsShape.ok()];
  assert.deepEqual(await send(msg({ platform: 'apns', token: 'a3' })), { ok: true });
  assert.equal(connects, before + 2, 'the silent session was retired and the next request opened another');
  // a stream that ends with no answer (its connection went away) is another try, not a final answer
  const gone = apnsOf({ timeoutMs: 2000 });
  script = [{ delay: 20, answer: apnsShape.ok() }];
  const doomed = gone(msg({ platform: 'apns', token: 'a4' }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  sessions.at(-1)!.destroy();
  assert.deepEqual(await doomed, { ok: false, retry: true, fault: true });
});

test('a 200 whose end is slow is a success, not a retry that would show the push twice', async () => {
  const send = apnsOf({ timeoutMs: 50 });
  script = ['headers-only'];
  assert.deepEqual(await send(msg({ platform: 'apns', token: 'h1' })), { ok: true });
});
