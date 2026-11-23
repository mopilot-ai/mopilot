// Two APNs credential sets on one relay (#5251): the old app (ai.mopilot.remote) and the App Store app (ai.mopilot.phone) each have their own
// topic, and a device token works with its own app's only. relay/src/{config,apns,apnsRouter,pushSenders,push,store,schema}.mjs against one fake
// APNs (an h2c server that answers by the topic header) and the embedded Postgres: nothing here is a real Apple key or endpoint.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { once } from 'node:events';
import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { apnsSetsOf } from '../relay/src/config.mjs';

import { PushService } from '../relay/src/push.mjs';
import { createSender } from '../relay/src/pushSenders.mjs';
import { migrate } from '../relay/src/schema.mjs';
import { Store } from '../relay/src/store.mjs';
import { parseSnapshot } from '../relay/src/activity.mjs';
import { Metrics } from '../relay/src/metrics.mjs';
import { makeClock, makeDb } from './support/relayKit.ts';

const OLD = 'ai.mopilot.remote';
const NEW = 'ai.mopilot.phone';
/** every set has a P-256 key of its own, so a request signed with another set's key shows */
const publicKeys = new Map<string, KeyObject>();
const setOf = (topic: string, sandbox = false) => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  publicKeys.set(`K-${topic}`, pair.publicKey);
  return {
    keyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    keyId: `K-${topic}`,
    teamId: `T-${topic}`,
    topic,
    sandbox,
  };
};

type Reply = { status: number; reason?: string };
const OK: Reply = { status: 200 };
const WRONG: Reply = { status: 400, reason: 'DeviceTokenNotForTopic' };
const BAD: Reply = { status: 400, reason: 'BadDeviceToken' };
const GONE: Reply = { status: 410, reason: 'Unregistered' };
const REVOKED: Reply = { status: 403, reason: 'InvalidProviderToken' };
/** what the fake APNs says to a token on a topic; every request it gets is recorded as `topic token` */
let answer: (topic: string, token: string) => Reply = () => OK;
const seen: string[] = [];
/** each request in full: the host it reached and what its provider token says (key id, team, and whether that key's signature verifies) */
const calls: { host: string; topic: string; kid: string; iss: string; signed: boolean }[] = [];
const fakeApns = (host: string) => {
  const server = http2.createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      const topic = String(req.headers['apns-topic']);
      const token = decodeURIComponent(String(req.headers[':path']).split('/').pop() ?? '');
      seen.push(`${topic} ${token}`);
      const [h, c, sig] = String(req.headers.authorization).replace('bearer ', '').split('.');
      const head = JSON.parse(Buffer.from(h, 'base64url').toString());
      const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
      const key = publicKeys.get(head.kid);
      const signed = !!key && verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
      calls.push({ host, topic, kid: head.kid, iss: claims.iss, signed });
      const r = answer(topic, token);
      res.writeHead(r.status);
      res.end(r.reason ? JSON.stringify({ reason: r.reason }) : '');
    });
  });
  server.listen(0, '127.0.0.1');
  return server;
};
const servers: Record<string, http2.Http2Server> = {
  'https://api.push.apple.com': fakeApns('production'),
  'https://api.sandbox.push.apple.com': fakeApns('sandbox'),
};
await Promise.all(Object.values(servers).map((server) => once(server, 'listening')));
const sessions: http2.ClientHttp2Session[] = [];
/** the authority a sender asks for decides which fake host answers: a sandbox set must reach the sandbox host */
const connect = (authority: string) => {
  const s = http2.connect(`http://127.0.0.1:${(servers[authority].address() as any).port}`);
  sessions.push(s);
  return s;
};
after(() => {
  for (const s of sessions) s.destroy();
  for (const server of Object.values(servers)) server.close();
});

/** the token belongs to `app`: its topic (a Live Activity's too) accepts it, every other refuses it as another app's */
const belongsTo =
  (app: string) =>
  (topic: string): Reply =>
    topic.startsWith(app) ? OK : WRONG;

const { db, reset } = await makeDb();
const store = new Store(db as any);
const clock = makeClock();
beforeEach(async () => {
  await reset();
  seen.length = 0;
  calls.length = 0;
  answer = () => OK;
});

/** a relay holding `sets` (the first is the default), sending through the real createSender to the fake APNs */
function rig(sets: ReturnType<typeof setOf>[], extra: { breakerFailures?: number; store?: Store } = {}) {
  const push = {
    mode: 'direct',
    proxyUrl: '',
    proxyToken: '',
    timeoutMs: 2000,
    breakerFailures: extra.breakerFailures ?? 5,
    breakerCooldownMs: 30_000,
    maxInFlight: 32,
    apns: sets[0],
    apnsSets: sets,
    fcm: null,
  };
  const metrics = new Metrics();
  const send = createSender(push as any, { connect, retry: { attempts: 1 }, metrics })!;
  const lines: any[] = [];
  const s = extra.store ?? store;
  const service = new PushService({
    store: s,
    send,
    now: clock.now,
    metrics,
    log: (event: string, data: object) => lines.push({ event, ...data }),
    apns: apnsSetsOf(push as any),
  });
  return { service, lines, metrics };
}
const pair = { pairId: 'p_pair00001', phoneDeviceId: 'ph1' };
const register = (service: PushService, token: string) => service.register({ deviceId: 'ph1', userId: 'u1', platform: 'apns', token });
let chat = 0;
const ask = (service: PushService) => service.request(pair, 'needsYou', `chat-${++chat}`);
const snapshot = () => parseSnapshot({ needs: 1, running: 1, kind: 'needs', since: 1_900_000_000, at: 1_900_000_100, rows: [] })!;

test('one set only (today): its topic is used, a refused token is removed, and nothing is remembered', async () => {
  const { service, lines, metrics } = rig([setOf(OLD)]);
  answer = (topic, token) => (token === 'mine' ? OK : WRONG);
  await register(service, 'mine');
  assert.equal(await ask(service), 'sent');
  assert.deepEqual(seen, [`${OLD} mine`]);
  assert.deepEqual(await store.pushTokenOf('ph1'), { platform: 'apns', token: 'mine' });
  assert.equal(lines.find((l) => l.event === 'push_token')?.topic, OLD);
  assert.match(metrics.render(), /relay_push_provider_total\{outcome="sent",provider="apns"\} 1/);
  await register(service, 'theirs');
  assert.equal(await ask(service), 'failed');
  assert.equal(await store.pushTokenOf('ph1'), null);
  assert.deepEqual(
    lines.filter((l) => l.kind === 'rejected').map((l) => [l.topic, l.environment, l.reason]),
    [[OLD, 'production', 'DeviceTokenNotForTopic']],
  );
});

test('a token of the second app: the default set refuses it, the second accepts it, the topic is remembered and the next send goes straight there', async () => {
  const { service, metrics } = rig([setOf(OLD), setOf(NEW)]);
  answer = (topic) => belongsTo(NEW)(topic);
  await register(service, 'new-app-token');
  assert.equal(await ask(service), 'sent');
  assert.deepEqual(seen, [`${OLD} new-app-token`, `${NEW} new-app-token`]);
  assert.deepEqual(await store.pushTokenOf('ph1'), { platform: 'apns', token: 'new-app-token', topic: NEW });
  seen.length = 0;
  assert.equal(await ask(service), 'sent');
  assert.deepEqual(seen, [`${NEW} new-app-token`]);
  // each set has its own metrics label and breaker
  assert.match(metrics.render(), /relay_push_provider_total\{outcome="invalid_token",provider="apns"\} 1/);
  assert.match(metrics.render(), /relay_push_provider_total\{outcome="sent",provider="apns2"\} 2/);
});

test('a token of the default app is accepted by the first set and remembered under it; BadDeviceToken from the first set also moves on', async () => {
  const { service } = rig([setOf(OLD), setOf(NEW)]);
  await register(service, 'old-app-token');
  answer = () => OK;
  assert.equal(await ask(service), 'sent');
  assert.deepEqual(seen, [`${OLD} old-app-token`]);
  assert.equal((await store.pushTokenOf('ph1'))?.topic, OLD);
  // the same token as another app's, refused by the first set as malformed for it
  await register(service, 'other');
  seen.length = 0;
  answer = (topic) => (topic === NEW ? OK : BAD);
  assert.equal(await ask(service), 'sent');
  assert.deepEqual(seen, [`${OLD} other`, `${NEW} other`]);
  assert.equal((await store.pushTokenOf('ph1'))?.topic, NEW);
});

test('a token every set refused is removed, and the log names the last topic tried', async () => {
  const { service, lines } = rig([setOf(OLD), setOf(NEW, true)]);
  answer = () => BAD;
  await register(service, 'dead');
  assert.equal(await ask(service), 'failed');
  assert.deepEqual(seen, [`${OLD} dead`, `${NEW} dead`]);
  assert.equal(await store.pushTokenOf('ph1'), null);
  assert.deepEqual(
    lines.filter((l) => l.kind === 'rejected').map((l) => [l.topic, l.environment]),
    [[NEW, 'sandbox']],
  );
});

test('a 410 from the first set is final: the other set is not asked and the token is removed', async () => {
  const { service } = rig([setOf(OLD), setOf(NEW)]);
  answer = () => GONE;
  await register(service, 'unregistered');
  assert.equal(await ask(service), 'failed');
  assert.deepEqual(seen, [`${OLD} unregistered`]);
  assert.equal(await store.pushTokenOf('ph1'), null);
});

test('a transient failure of the first set (a 5xx) ends the send: the other set is not asked, the token is kept and not pinned to either set', async () => {
  const { service } = rig([setOf(OLD), setOf(NEW)]);
  answer = () => ({ status: 503 });
  await register(service, 'tok');
  assert.equal(await ask(service), 'failed');
  assert.deepEqual(seen, [`${OLD} tok`]);
  assert.deepEqual(await store.pushTokenOf('ph1'), { platform: 'apns', token: 'tok' });
});

test('a first set that cannot answer (APNs refuses its key, or its breaker is open) does not stop the second set, and the token is kept whatever the second says', async () => {
  const { service } = rig([setOf(OLD), setOf(NEW)], { breakerFailures: 1 });
  // the old team's key is revoked: 403 InvalidProviderToken for every token on its topic
  answer = (topic) => (topic === OLD ? REVOKED : belongsTo(NEW)(topic));
  await register(service, 'new-app-token');
  assert.equal(await ask(service), 'sent');
  assert.deepEqual(seen, [`${OLD} new-app-token`, `${NEW} new-app-token`]);
  assert.equal((await store.pushTokenOf('ph1'))?.topic, NEW);
  // now the first set's breaker is open: a token of the new app with no remembered set still reaches the second set without asking APNs on the first
  await register(service, 'another-new-token');
  seen.length = 0;
  assert.equal(await ask(service), 'sent');
  assert.deepEqual(seen, [`${NEW} another-new-token`]);
  assert.equal((await store.pushTokenOf('ph1'))?.topic, NEW);
  // the token of the old app has nowhere to go while its set is unusable, and is kept: the other set refusing it (wrong app) proves nothing
  await register(service, 'old-app-token');
  seen.length = 0;
  answer = (topic) => (topic === OLD ? REVOKED : WRONG);
  assert.equal(await ask(service), 'failed');
  assert.deepEqual(await store.pushTokenOf('ph1'), { platform: 'apns', token: 'old-app-token' });
});

test('a set that cannot answer never removes a token: both sets unusable, or one unusable and the other refusing, keep it; a 410 from the other still removes it', async () => {
  const { service, lines } = rig([setOf(OLD), setOf(NEW)]);
  await register(service, 'tok');
  answer = () => REVOKED;
  assert.equal(await ask(service), 'failed');
  assert.deepEqual(seen, [`${OLD} tok`, `${NEW} tok`]);
  assert.ok(await store.pushTokenOf('ph1'));
  answer = (topic) => (topic === OLD ? REVOKED : WRONG);
  assert.equal(await ask(service), 'failed');
  assert.deepEqual(await store.pushTokenOf('ph1'), { platform: 'apns', token: 'tok' });
  assert.deepEqual(
    lines.filter((l) => l.kind === 'rejected'),
    [],
  );
  answer = (topic) => (topic === OLD ? REVOKED : GONE);
  assert.equal(await ask(service), 'failed');
  assert.equal(await store.pushTokenOf('ph1'), null);
});

test('each set signs with its own key and team and goes to its own host: a sandbox set reaches the sandbox host, a production set the production host', async () => {
  const { service } = rig([setOf(OLD), setOf(NEW, true)]);
  answer = (topic) => belongsTo(NEW)(topic);
  await register(service, 'new-app-token');
  assert.equal(await ask(service), 'sent');
  assert.deepEqual(calls, [
    { host: 'production', topic: OLD, kid: `K-${OLD}`, iss: `T-${OLD}`, signed: true },
    { host: 'sandbox', topic: NEW, kid: `K-${NEW}`, iss: `T-${NEW}`, signed: true },
  ]);
});

test('two sends for one token at once both find the second set and remember the same topic; two that are both refused both end with the token gone', async () => {
  const { service } = rig([setOf(OLD), setOf(NEW)]);
  answer = (topic) => belongsTo(NEW)(topic);
  await register(service, 'tok');
  assert.deepEqual(await Promise.all([ask(service), ask(service)]), ['sent', 'sent']);
  assert.deepEqual(await store.pushTokenOf('ph1'), { platform: 'apns', token: 'tok', topic: NEW });
  await register(service, 'dead');
  answer = () => BAD;
  assert.deepEqual(await Promise.all([ask(service), ask(service)]), ['failed', 'failed']);
  assert.equal(await store.pushTokenOf('ph1'), null);
});

test('with one set (today) a token it refuses as another app, as malformed or as unregistered is removed', async () => {
  const { service } = rig([setOf(OLD)]);
  for (const refusal of [WRONG, BAD, GONE]) {
    await register(service, 'tok');
    answer = () => refusal;
    assert.equal(await ask(service), 'failed');
    assert.deepEqual(seen.splice(0), [`${OLD} tok`]);
    assert.equal(await store.pushTokenOf('ph1'), null);
  }
  // and a refused credential keeps the token, as before
  await register(service, 'tok');
  answer = () => REVOKED;
  assert.equal(await ask(service), 'failed');
  assert.ok(await store.pushTokenOf('ph1'));
});

test('a key that is not a p8 private key stops the relay at boot and names its topic, never the key', () => {
  const bad = { ...setOf(NEW), keyPem: 'not a pem, secret-text' };
  assert.throws(
    () =>
      createSender({
        mode: 'direct',
        timeoutMs: 1,
        breakerFailures: 1,
        breakerCooldownMs: 1,
        maxInFlight: 1,
        apns: setOf(OLD),
        apnsSets: [setOf(OLD), bad],
        fcm: null,
      } as any),
    (e: Error) => e.message.includes(NEW) && !e.message.includes('secret-text'),
  );
});

test('registering a different token forgets the remembered set; the same token again keeps it; a remembered topic that is no set any more is ignored', async () => {
  const { service, lines } = rig([setOf(OLD), setOf(NEW)]);
  answer = (topic) => belongsTo(NEW)(topic);
  await register(service, 'a');
  await ask(service);
  assert.equal((await store.pushTokenOf('ph1'))?.topic, NEW);
  await register(service, 'a');
  assert.equal((await store.pushTokenOf('ph1'))?.topic, NEW);
  // with several sets, a token whose set is unknown names neither environment nor topic; once remembered, it names its set
  const tokenLines = lines.filter((l) => l.event === 'push_token').map((l) => [l.kind, l.topic, l.environment]);
  assert.deepEqual(tokenLines, [
    ['registered', undefined, undefined],
    ['same', NEW, 'production'],
  ]);
  await register(service, 'b');
  assert.deepEqual(await store.pushTokenOf('ph1'), { platform: 'apns', token: 'b' });
  await db.query("UPDATE relay_push_tokens SET topic = 'ai.gone' WHERE device_id = 'ph1'");
  seen.length = 0;
  assert.equal(await ask(service), 'sent');
  assert.deepEqual(seen, [`${OLD} b`, `${NEW} b`]);
});

test('a store that cannot remember the set does not turn a push that went out into an error', async () => {
  const broken = new Store(db as any);
  broken.setPushTopic = async () => {
    throw new Error('db down');
  };
  broken.setActivityTopic = async () => {
    throw new Error('db down');
  };
  const { service, lines } = rig([setOf(OLD), setOf(NEW)], { store: broken });
  answer = (topic) => belongsTo(NEW)(topic);
  await register(service, 'tok');
  assert.equal(await ask(service), 'sent');
  await broken.setActivityToken({ deviceId: 'ph1', userId: 'u1', token: 'act', now: clock.now() });
  assert.equal(await service.activity({ phoneDeviceId: 'ph1', pairId: 'p_pair00001' }, snapshot()), 'sent');
  assert.deepEqual(
    lines.filter((l) => l.event === 'push_topic_failed').map((l) => l.message),
    ['db down', 'db down'],
  );
  // a thrown non-Error is reported as text
  broken.setPushTopic = async () => {
    throw 'plain';
  };
  await register(service, 'tok2');
  assert.equal(await ask(service), 'sent');
  assert.equal(lines.at(-1).message, 'plain');
});

test('a Live Activity push uses the topic of the set that accepts it, with the liveactivity suffix, and follows the same rule', async () => {
  const { service } = rig([setOf(OLD), setOf(NEW)]);
  const phone = { phoneDeviceId: 'ph1', pairId: 'p_pair00001' };
  answer = (topic, token) => (topic.startsWith(NEW) && token === 'act-new' ? OK : WRONG);
  await store.setActivityToken({ deviceId: 'ph1', userId: 'u1', token: 'act-new', now: clock.now() });
  assert.equal(await service.activity(phone, snapshot()), 'sent');
  assert.deepEqual(seen, [`${OLD}.push-type.liveactivity act-new`, `${NEW}.push-type.liveactivity act-new`]);
  assert.equal(await store.activityTopicOf('ph1', 'act-new'), NEW);
  // a new state goes straight to the remembered set
  seen.length = 0;
  assert.equal(await service.activity(phone, snapshot()), 'sent');
  assert.deepEqual(seen, [`${NEW}.push-type.liveactivity act-new`]);
  // a different activity token starts without a remembered set; the same one again keeps it
  await store.setActivityToken({ deviceId: 'ph1', userId: 'u1', token: 'act-new', now: clock.now() });
  assert.equal(await store.activityTopicOf('ph1', 'act-new'), NEW);
  await store.setActivityToken({ deviceId: 'ph1', userId: 'u1', token: 'act-2', now: clock.now() });
  assert.equal(await store.activityTopicOf('ph1', 'act-2'), null);
  assert.equal(await store.activityTopicOf('ph1', 'act-new'), null);
  // refused by both sets: the activity token (not the alert token) is removed
  await store.setPushToken({ deviceId: 'ph1', userId: 'u1', platform: 'apns', token: 'alert', now: clock.now() });
  answer = () => BAD;
  seen.length = 0;
  assert.equal(await service.activity(phone, snapshot()), 'failed');
  assert.deepEqual(seen, [`${OLD}.push-type.liveactivity act-2`, `${NEW}.push-type.liveactivity act-2`]);
  assert.equal(await store.activityTokenOf('ph1'), null);
  assert.ok(await store.pushTokenOf('ph1'));
});

test('with one set a Live Activity push asks the store for no topic', async () => {
  const { service } = rig([setOf(OLD)]);
  const asked: string[] = [];
  const original = store.activityTopicOf.bind(store);
  store.activityTopicOf = async (...a: [string, string]) => (asked.push(a[1]), original(...a));
  await store.setActivityToken({ deviceId: 'ph1', userId: 'u1', token: 'act', now: clock.now() });
  assert.equal(await service.activity({ phoneDeviceId: 'ph1', pairId: 'p_pair00001' }, snapshot()), 'sent');
  store.activityTopicOf = original;
  assert.deepEqual(asked, []);
  assert.deepEqual(seen, [`${OLD}.push-type.liveactivity act`]);
});

test('the schema step adds the topic columns and can run again on a database that has them', async () => {
  await migrate(db as any);
  const { rows } = await db.query(
    "SELECT table_name FROM information_schema.columns WHERE column_name = 'topic' AND table_name IN ('relay_push_tokens', 'relay_activity_tokens') ORDER BY table_name",
  );
  assert.deepEqual(
    rows.map((r: any) => r.table_name),
    ['relay_activity_tokens', 'relay_push_tokens'],
  );
});
