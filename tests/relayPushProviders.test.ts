// relay/src/{apns,fcm,pushRetry,pushPayload,pushSenders}.mjs against fake providers: an h2c server standing in for APNs and a fake fetch for FCM, with no real key.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { once } from 'node:events';
import { generateKeyPairSync, verify } from 'node:crypto';
import { apnsSender } from '../relay/src/apns.mjs';
import { fcmSender } from '../relay/src/fcm.mjs';
import { createSender } from '../relay/src/pushSenders.mjs';
import { withRetry, retryAfterMs } from '../relay/src/pushRetry.mjs';
import { apnsBody, fcmMessage } from '../relay/src/pushPayload.mjs';

const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ecPem = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaPem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

const msg = (o: object = {}) => ({
  platform: 'apns' as const,
  token: 'tok/1',
  kind: 'needsYou',
  title: 'A chat needs you',
  count: 1,
  collapseId: 'c'.repeat(32),
  ref: 'chat-ref',
  ...o,
});

test('only a "needs you" push is time-sensitive; every other kind, a sealed one and an Android one keep the default level', () => {
  const level = (o: object) => (apnsBody(msg(o)) as any).aps['interruption-level'];
  assert.equal(level({}), 'time-sensitive');
  assert.equal(level({ sealed: 'S' }), 'time-sensitive');
  for (const kind of ['done', 'momoNeedsYou', 'machineOffline']) assert.equal(level({ kind }), undefined, kind);
  assert.ok(!JSON.stringify(fcmMessage(msg({ platform: 'fcm' }))).includes('interruption'));
});

test('a clearing is quiet and has nothing to answer: passive, no sound, no category, and its own kind to the phone', () => {
  const m = msg({ kind: 'cleared', title: 'A chat no longer needs you' });
  const { aps, ...rest } = apnsBody(m) as any;
  assert.deepEqual(aps, {
    alert: { title: 'A chat no longer needs you', body: '' },
    'interruption-level': 'passive',
    'thread-id': 'c'.repeat(32),
  });
  assert.deepEqual(rest, { kind: 'cleared', ref: 'chat-ref' });
  // Android: the app reads the kind and takes the waiting notification away instead of drawing this one
  assert.equal((fcmMessage(msg({ platform: 'fcm', kind: 'cleared' })) as any).data.kind, 'cleared');
});

test('the alert is the fixed title with an empty body; mutable-content only with a sealed blob; no chat text', () => {
  const plain = apnsBody(msg()) as any;
  assert.deepEqual(plain.aps.alert, { title: 'A chat needs you', body: '' });
  assert.equal('mutable-content' in plain.aps, false);
  assert.equal(plain.aps.category, 'mopilot.needsYou');
  assert.equal('category' in (apnsBody(msg({ kind: 'machineOffline' })) as any).aps, false);
  assert.equal((apnsBody(msg({ kind: 'done' })) as any).aps.category, 'mopilot.done');
  assert.equal('st' in plain, false);
  const sealed = apnsBody(msg({ sealed: 'SEALED' })) as any;
  assert.equal(sealed.aps['mutable-content'], 1);
  assert.equal(sealed.st, 'SEALED');
  // Android always gets a data-only, high-priority message: the app posts the notification, the fixed title is its fallback
  const f = fcmMessage(msg({ platform: 'fcm', count: 2 })) as any;
  assert.equal('notification' in f, false);
  assert.equal('notification' in f.android, false);
  assert.equal(f.android.priority, 'HIGH');
  assert.deepEqual(f.data, { kind: 'needsYou', ref: 'chat-ref', title: 'A chat needs you', count: '2' });
  const dataOnly = fcmMessage(msg({ platform: 'fcm', sealed: 'S' })) as any;
  assert.equal('notification' in dataOnly, false);
  assert.deepEqual(dataOnly.data, { kind: 'needsYou', ref: 'chat-ref', title: 'A chat needs you', count: '1', st: 'S' });
  assert.equal(dataOnly.token, 'tok/1');
});

test('retry: a retryable failure is tried again with backoff or Retry-After, then gives up; a final one is not retried', async () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  let n = 0;
  const flaky = withRetry(async () => (++n < 3 ? { ok: false, retry: true, ...(n === 2 && { retryAfterMs: 7 }) } : { ok: true }), {
    sleep,
  });
  assert.deepEqual(await flaky(msg()), { ok: true });
  assert.deepEqual(sleeps, [500, 7]);
  n = 0;
  sleeps.length = 0;
  const always = withRetry(async () => (n++, { ok: false, retry: true }), { sleep, attempts: 2, maxMs: 100 });
  assert.deepEqual(await always(msg()), { ok: false });
  assert.equal(n, 2);
  assert.deepEqual(sleeps, [100]);
  n = 0;
  const dead = withRetry(async () => (n++, { ok: false, invalidToken: true }), { sleep });
  assert.deepEqual(await dead(msg()), { ok: false, invalidToken: true });
  const refused = withRetry(async () => ({ ok: false, status: 400, reason: 'TopicDisallowed' }), { sleep });
  assert.deepEqual(await refused(msg()), { ok: false, status: 400, reason: 'TopicDisallowed' });
  assert.equal(n, 1);
  const thrown = withRetry(async () => Promise.reject(new Error('x')), { sleep, attempts: 2 });
  assert.deepEqual(await thrown(msg()), { ok: false, fault: true });
  // the default sleep waits for real
  let m = 0;
  const quick = withRetry(async () => (++m < 2 ? { ok: false, retry: true, retryAfterMs: 1 } : { ok: true }));
  assert.equal((await quick(msg())).ok, true);
});

test('Retry-After reads seconds or a date and ignores junk', () => {
  assert.equal(retryAfterMs('3'), 3000);
  assert.equal(retryAfterMs('Thu, 01 Jan 2030 00:00:10 GMT', Date.UTC(2030, 0, 1)), 10_000);
  assert.equal(retryAfterMs('Thu, 01 Jan 2030 00:00:00 GMT', Date.UTC(2030, 0, 2)), 0);
  assert.equal(retryAfterMs('soon'), undefined);
  assert.equal(retryAfterMs(null), undefined);
  assert.equal(typeof retryAfterMs('1', undefined), 'number');
});

// ---- APNs -------------------------------------------------------------------------------------------------------

type Reply = { goaway?: boolean; status: number; body?: object | string; delay?: number; reset?: boolean };
const seen: { headers: http2.IncomingHttpHeaders; body: string }[] = [];
let replies: Reply[] = [];
const server = http2.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
    const r = replies.shift() ?? { status: 200 };
    if (r.goaway) req.stream.session?.goaway();
    if (r.reset) return void req.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    if (r.delay) return void setTimeout(() => res.end(), r.delay).unref();
    res.writeHead(r.status, r.status === 429 ? { 'retry-after': '4' } : {});
    res.end(typeof r.body === 'string' ? r.body : r.body ? JSON.stringify(r.body) : '');
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const URL_H2C = `http://127.0.0.1:${(server.address() as any).port}`;
const sessions: http2.ClientHttp2Session[] = [];
const connect = (authority: string) => {
  seenAuthority.push(authority);
  const s = http2.connect(URL_H2C);
  sessions.push(s);
  return s;
};
const seenAuthority: string[] = [];
after(() => {
  for (const s of sessions) s.destroy();
  server.close();
});

const apns = (o: object = {}) => apnsSender({ keyPem: ecPem, keyId: 'KEY123', teamId: 'TEAM456', topic: 'ai.mopilot.app', connect, ...o });

test('APNs: path, headers, empty-body alert, and a provider token that verifies and is cached', async () => {
  seen.length = 0;
  replies = [{ status: 200 }, { status: 200 }];
  let t = 1_700_000_000_000;
  const send = apns({ now: () => t });
  assert.deepEqual(await send(msg({ sealed: 'SEALED' })), { ok: true });
  const { headers, body } = seen[0];
  assert.equal(headers[':path'], '/3/device/tok%2F1');
  assert.equal(headers['apns-topic'], 'ai.mopilot.app');
  assert.equal(headers['apns-push-type'], 'alert');
  assert.equal(headers['apns-collapse-id'], 'c'.repeat(32));
  assert.deepEqual(JSON.parse(body).aps.alert, { title: 'A chat needs you', body: '' });
  assert.equal(JSON.parse(body).aps['mutable-content'], 1);
  const jwt = String(headers.authorization).replace('bearer ', '');
  const [h, c, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'ES256', kid: 'KEY123' });
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url').toString()), { iss: 'TEAM456', iat: 1_700_000_000 });
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  t += 60_000;
  await send(msg());
  assert.equal(seen[1].headers.authorization, headers.authorization);
  t += 31 * 60_000;
  replies = [{ status: 200 }];
  await send(msg());
  assert.notEqual(seen[2].headers.authorization, headers.authorization);
  assert.equal(seenAuthority.at(-1), 'https://api.push.apple.com');
});

test('APNs: the sandbox host, a long collapse id cut to 64 bytes, and one session reused until it closes', async () => {
  seen.length = 0;
  seenAuthority.length = 0;
  replies = [{ status: 200 }, { status: 200 }, { status: 200 }];
  const send = apns({ sandbox: true });
  await send(msg({ collapseId: 'x'.repeat(100) }));
  await send(msg());
  assert.equal(seen[0].headers['apns-collapse-id'], 'x'.repeat(64));
  assert.deepEqual(seenAuthority, ['https://api.sandbox.push.apple.com']);
  sessions.at(-1)!.close();
  await once(sessions.at(-1)!, 'close');
  await send(msg());
  assert.equal(seenAuthority.length, 2);
});

test('APNs: 410 and BadDeviceToken are dead tokens; 429/5xx retry (with Retry-After); other 4xx are final', async () => {
  const send = apns();
  replies = [{ status: 410, body: { reason: 'Unregistered' } }];
  assert.deepEqual(await send(msg()), { ok: false, invalidToken: true, status: 410, reason: 'Unregistered' });
  replies = [{ status: 400, body: { reason: 'BadDeviceToken' } }];
  // the 400 means "not this credential set's app" (`wrongApp`): with one set it ends in the same removal, with more the next set is tried
  assert.deepEqual(await send(msg()), { ok: false, invalidToken: true, wrongApp: true, status: 400, reason: 'BadDeviceToken' });
  // what Apple said stays with the result, so a refused push can be told from one that was never sent
  replies = [{ status: 400, body: { reason: 'PayloadEmpty' } }];
  assert.deepEqual(await send(msg()), {
    ok: false,
    retry: false,
    retryAfterMs: undefined,
    fault: false,
    status: 400,
    reason: 'PayloadEmpty',
  });
  replies = [{ status: 429, body: { reason: 'TooManyRequests' } }];
  assert.deepEqual(await send(msg()), { ok: false, retry: true, retryAfterMs: 4000, fault: false, status: 429, reason: 'TooManyRequests' });
  replies = [{ status: 400, body: {} }];
  assert.equal((await send(msg())).retry, false);
  replies = [{ status: 503, body: 'not json' }];
  assert.equal((await send(msg())).retry, true);
});

test('APNs: an expired provider token is re-signed on the retry; a reset stream and a stalled one retry', async () => {
  seen.length = 0;
  let t = 1_700_000_000_000;
  const retry = { sleep: async () => undefined };
  const send = withRetry(apns({ now: () => (t += 1000) }), retry);
  replies = [{ status: 403, body: { reason: 'ExpiredProviderToken' } }, { status: 200 }];
  assert.deepEqual(await send(msg()), { ok: true });
  assert.notEqual(seen[0].headers.authorization, seen[1].headers.authorization);
  replies = [{ status: 0, reset: true }, { status: 200 }];
  assert.deepEqual(await send(msg()), { ok: true });
  replies = [{ status: 200, delay: 300 }];
  assert.deepEqual(await apns({ timeoutMs: 20 })(msg()), { ok: false, retry: true, fault: true });
  await new Promise((r) => setTimeout(r, 350));
});

test('APNs: a GOAWAY retires the session; the next request opens a new one', async () => {
  seenAuthority.length = 0;
  replies = [{ status: 200, goaway: true }, { status: 200 }];
  const send = apns();
  assert.equal((await send(msg())).ok, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await send(msg())).ok, true);
  assert.equal(seenAuthority.length, 2);
});

test('a long Retry-After is capped so a push never holds the relay for a minute', async () => {
  const sleeps: number[] = [];
  const send = withRetry(async () => ({ ok: false, retry: true, retryAfterMs: 60_000 }), { sleep: async (ms) => void sleeps.push(ms) });
  await send(msg());
  assert.deepEqual(sleeps, [5000, 5000]);
});

test('APNs: a connect that throws is a retryable failure', async () => {
  const send = apnsSender({
    keyPem: ecPem,
    keyId: 'k',
    teamId: 't',
    topic: 'x',
    connect: () => {
      throw new Error('no route');
    },
  });
  assert.deepEqual(await send(msg()), { ok: false, retry: true, fault: true });
});

// ---- FCM --------------------------------------------------------------------------------------------------------

const sa = { client_email: 'svc@proj.iam.gserviceaccount.com', private_key: rsaPem, project_id: 'proj-1' };
type Call = { url: string; init: any };
function fakeGoogle(plan: (call: Call, n: number) => { status: number; json?: any; headers?: Record<string, string> } | Error) {
  const calls: Call[] = [];
  const f = async (url: string, init: any) => {
    calls.push({ url, init });
    const r = plan({ url, init }, calls.length);
    if (r instanceof Error) throw r;
    return {
      ok: r.status < 300,
      status: r.status,
      headers: new Headers(r.headers),
      json: async () => r.json ?? Promise.reject(new Error('no body')),
    };
  };
  return { calls, f: f as any };
}
const tokenReply = { status: 200, json: { access_token: 'AT1', expires_in: 3600 } };

test('FCM: mints an OAuth token with a verifiable RS256 assertion, sends the v1 message, and caches the token', async () => {
  let t = 1_700_000_000_000;
  const g = fakeGoogle((c) => (c.url.includes('oauth2') ? tokenReply : { status: 200, json: {} }));
  const send = fcmSender({ serviceAccount: sa, fetch: g.f, now: () => t });
  assert.deepEqual(await Promise.all([send(msg({ platform: 'fcm' })), send(msg({ platform: 'fcm' }))]), [{ ok: true }, { ok: true }]);
  assert.equal(g.calls.filter((c) => c.url.includes('oauth2')).length, 1);
  const mint = g.calls[0];
  const assertion = new URLSearchParams(String(mint.init.body)).get('assertion')!;
  const [h, c, sig] = assertion.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claims.iss, sa.client_email);
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), rsa.publicKey, Buffer.from(sig, 'base64url')));
  const call = g.calls.find((x) => x.url.includes('messages:send'))!;
  assert.equal(call.url, 'https://fcm.googleapis.com/v1/projects/proj-1/messages:send');
  assert.equal(call.init.headers.authorization, 'Bearer AT1');
  const sent = JSON.parse(call.init.body).message;
  assert.equal('notification' in sent, false, 'no Android push carries a notification block');
  assert.equal(sent.data.title, 'A chat needs you');
  t += 3600_000;
  await send(msg({ platform: 'fcm' }));
  assert.equal(g.calls.filter((x) => x.url.includes('oauth2')).length, 2);
});

test('FCM: a custom token endpoint and an unspecified lifetime are honored', async () => {
  const g = fakeGoogle((c) =>
    c.url === 'https://tok.example/t' ? { status: 200, json: { access_token: 'A' } } : { status: 200, json: {} },
  );
  const send = fcmSender({ serviceAccount: { ...sa, token_uri: 'https://tok.example/t' }, fetch: g.f, baseUrl: 'https://fcm.example' });
  assert.equal((await send(msg())).ok, true);
  assert.equal(g.calls[1].url, 'https://fcm.example/v1/projects/proj-1/messages:send');
});

test('FCM: a failed or unusable token exchange is a retryable failure, and a later send mints again', async () => {
  for (const bad of [{ status: 500 }, { status: 200, json: {} }, new Error('down')]) {
    const g = fakeGoogle(() => bad as any);
    assert.deepEqual(await fcmSender({ serviceAccount: sa, fetch: g.f })(msg()), { ok: false, retry: true, fault: true });
  }
  let n = 0;
  const g = fakeGoogle((c) => (c.url.includes('oauth2') ? (++n === 1 ? { status: 500 } : tokenReply) : { status: 200, json: {} }));
  const send = fcmSender({ serviceAccount: sa, fetch: g.f });
  assert.equal((await send(msg())).ok, false);
  assert.equal((await send(msg())).ok, true);
});

test('FCM: 401 refreshes the token on retry; UNREGISTERED and 404 are dead tokens; 429/5xx/network retry; other 4xx are final', async () => {
  let reply: any = { status: 200, json: {} };
  const g = fakeGoogle((c) => (c.url.includes('oauth2') ? tokenReply : reply));
  const send = fcmSender({ serviceAccount: sa, fetch: g.f });
  reply = { status: 401, json: { error: { status: 'UNAUTHENTICATED' } } };
  assert.deepEqual(await send(msg()), { ok: false, retry: true, fault: true });
  assert.equal(g.calls.filter((c) => c.url.includes('oauth2')).length, 1);
  reply = { status: 200, json: {} };
  await send(msg());
  assert.equal(g.calls.filter((c) => c.url.includes('oauth2')).length, 2);
  reply = { status: 400, json: { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } } };
  assert.deepEqual(await send(msg()), { ok: false, invalidToken: true });
  reply = { status: 404, json: {} };
  assert.deepEqual(await send(msg()), { ok: false, invalidToken: true });
  reply = { status: 400, json: { error: { status: 'INVALID_ARGUMENT', details: [{ fieldViolations: [{ field: 'message.token' }] }] } } };
  assert.deepEqual(await send(msg()), { ok: false, invalidToken: true });
  reply = { status: 400, json: { error: { status: 'INVALID_ARGUMENT', details: [{ fieldViolations: [{ field: 'x' }] }, {}] } } };
  assert.equal((await send(msg())).retry, false);
  reply = { status: 400, json: { error: { status: 'INVALID_ARGUMENT', details: 'x' } } };
  assert.deepEqual(await send(msg()), { ok: false, retry: false, retryAfterMs: undefined, fault: false });
  reply = { status: 429, headers: { 'retry-after': '9' } };
  assert.deepEqual(await send(msg()), { ok: false, retry: true, retryAfterMs: 9000, fault: false });
  reply = { status: 503, json: {} };
  assert.equal((await send(msg())).retry, true);
  reply = new Error('reset');
  assert.deepEqual(await send(msg()), { ok: false, retry: true, fault: true });
});

// ---- createSender ---------------------------------------------------------------------------------------------------

test('createSender: none is null; direct routes by platform and a platform without keys fails; proxy retries', async () => {
  assert.equal(createSender({ mode: 'none', proxyUrl: '', proxyToken: '' } as any), null);
  const g = fakeGoogle((c) => (c.url.includes('oauth2') ? tokenReply : { status: 200, json: {} }));
  replies = [{ status: 200 }];
  seen.length = 0;
  const both = createSender(
    { mode: 'direct', apns: { keyPem: ecPem, keyId: 'k', teamId: 't', topic: 'x', sandbox: false }, fcm: sa } as any,
    { fetch: g.f, connect },
  )!;
  assert.deepEqual(await both(msg()), { ok: true });
  assert.equal(seen.length, 1);
  assert.deepEqual(await both(msg({ platform: 'fcm' })), { ok: true });
  assert.ok(g.calls.some((c) => c.url.includes('messages:send')));
  const fcmOnly = createSender({ mode: 'direct', apns: null, fcm: sa } as any, { fetch: g.f })!;
  assert.deepEqual(await fcmOnly(msg()), { ok: false });
  const apnsOnly = createSender({ mode: 'direct', fcm: null, apns: { keyPem: ecPem, keyId: 'k', teamId: 't', topic: 'x' } } as any, {
    connect,
  })!;
  assert.deepEqual(await apnsOnly(msg({ platform: 'fcm' })), { ok: false });
  let n = 0;
  const proxyFetch = (async () =>
    ++n < 2 ? { ok: false, status: 503, headers: new Headers() } : { ok: true, status: 200, headers: new Headers() }) as any;
  const proxy = createSender({ mode: 'proxy', proxyUrl: 'https://p', proxyToken: '' } as any, {
    fetch: proxyFetch,
    retry: { sleep: async () => undefined },
  })!;
  assert.deepEqual(await proxy(msg()), { ok: true });
  assert.equal(n, 2);
});

test('APNs: a Live Activity update has its own push type, topic suffix and priority, no collapse id, and only the activity body', async () => {
  seen.length = 0;
  replies = [{ status: 200 }];
  const state = { needs: 1, running: 2, kind: 'needs', since: 1_700_000_000, rows: [] };
  const activity = {
    timestamp: 1_700_000_100,
    event: 'update' as const,
    state,
    staleAt: 1_700_001_300,
    dismissAt: 1_700_000_100,
    priority: 10 as const,
  };
  assert.deepEqual(await apns()(msg({ kind: 'activity', title: '', count: 0, collapseId: '', ref: '', activity })), { ok: true });
  const { headers, body } = seen[0];
  assert.equal(headers['apns-push-type'], 'liveactivity');
  assert.equal(headers['apns-topic'], 'ai.mopilot.app.push-type.liveactivity');
  assert.equal(headers['apns-priority'], '10');
  assert.equal('apns-collapse-id' in headers, false);
  assert.deepEqual(JSON.parse(body), {
    aps: { timestamp: 1_700_000_100, event: 'update', 'content-state': state, 'stale-date': 1_700_001_300 },
  });
  // an ended activity also names when the system removes it
  const ended = apnsBody(msg({ activity: { ...activity, event: 'end', dismissAt: 1_700_000_340 } })) as any;
  assert.equal(ended.aps.event, 'end');
  assert.equal(ended.aps['dismissal-date'], 1_700_000_340);
});
