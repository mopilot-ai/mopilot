// The independent review's findings on MoMo's Google connector, each as a test that fails without its fix: pinned endpoints, a refresh that cannot undo a disconnect, one account only, kept connect day, no token in an error, 403 reasons and retries, HTML limits, scopes, flows, cursors and the catcher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import * as io from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { AccountError } from '../shared/momoGoogle/account.mjs';
import { BODY_CAP, createGoogleClient, htmlToText } from '../shared/momoGoogle/client.mjs';
import { GOOGLE_OAUTH, iosClientConfig, parseClientConfig } from '../shared/momoGoogle/clientConfig.mjs';
import { GoogleConsent, type ConsentError } from '../shared/momoGoogle/consent.mjs';
import { delay, GoogleApiError, isRetryable, isScopeProblem, readError } from '../shared/momoGoogle/errors.mjs';
import { sealHandoff } from '../shared/momoGoogle/handoff.mjs';
import { createSealer } from '../shared/momoGoogle/seal.mjs';
import { createSender, createSendGrants, messageDigest } from '../shared/momoGoogle/send.mjs';
import { createVersionStore, type SafeStorage } from '../shared/momoGoogle/store.mjs';
import { READ_SCOPES, SEND_SCOPE } from '../shared/momoGoogle/types.mjs';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { idToken, startFake, type FakeAnswer } from './support/fakeGoogle.ts';
import { makeAccount, memoryFile, NOW, record } from './support/googleAccountKit.ts';

/** A record whose access token has run out, so the next read refreshes. */
const expired = () => record({ tokens: { ...record().tokens, expiresAt: 0 } });

const require = createRequire(import.meta.url);
const { createLoopbackCatcher } = require('../electron/momo/googleCatcher.cjs');
const sealer = createSealer(createNodePrimitives());
const DAY = 86_400_000;
const REDIRECT = 'http://127.0.0.1:53682/callback';
const code = (c: string) => (e: unknown) => (e as ConsentError).code === c;
const SECRET = 'SECRET-ACCESS-TOKEN-123';

// 1. endpoints are Google's, whatever the client file says
test('a client file cannot name the endpoints the tokens are sent to', () => {
  const evil = JSON.stringify({
    installed: { client_id: 'id', client_secret: 'sec', auth_uri: 'https://evil.example/auth', token_uri: 'https://evil.example/token' },
  });
  const c = parseClientConfig(evil);
  assert.deepEqual([c.authUri, c.tokenUri, c.revokeUri], [GOOGLE_OAUTH.authUri, GOOGLE_OAUTH.tokenUri, GOOGLE_OAUTH.revokeUri]);
  assert.ok([c.authUri, c.tokenUri, c.revokeUri].every((u) => /^https:\/\/(accounts\.google\.com|oauth2\.googleapis\.com)\//.test(u)));
  assert.deepEqual(iosClientConfig('ios-client-123456.apps.googleusercontent.com').tokenUri, GOOGLE_OAUTH.tokenUri);
});

// 9. scopes are read from every token answer
test('a refresh that no longer holds a read scope ends the grant; canSend follows the scopes really granted', async () => {
  const fake = await startFake((r) =>
    r.path === '/token'
      ? { body: { access_token: 'x', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly' } }
      : undefined,
  );
  try {
    const file = memoryFile(expired());
    const { account } = makeAccount({ config: fake.config, fetch: fake.fetch, file });
    await assert.rejects(account.accessToken(), (e: AccountError) => e.cause_ === 'scope_missing');
    assert.equal((await account.status()).state, 'needs_sign_in');
    const sendOnlyRefresh = makeAccount({
      config: fake.config,
      fetch: fake.fetch,
      file: memoryFile(record({ tokens: { ...record().tokens, scopes: [...READ_SCOPES] } })),
    });
    const st = await sendOnlyRefresh.account.status();
    assert.equal(st.state === 'connected' && st.canSend, false);
  } finally {
    await fake.close();
  }
});

// 3 and 4. one account; the connect day is kept
async function consentRig(
  prior = record(),
  token: FakeAnswer = {
    body: { access_token: 'a2', refresh_token: 'r2', expires_in: 3600, scope: READ_SCOPES.join(' '), id_token: idToken('me@example.com') },
  },
) {
  const fake = await startFake((r) => (r.path === '/token' ? token : r.path === '/revoke' ? { body: {} } : undefined));
  const kit = makeAccount({ config: fake.config, fetch: fake.fetch, file: memoryFile(prior) });
  const consent = new GoogleConsent({ account: kit.account, config: fake.config, sealer, fetch: fake.fetch, now: () => kit.clock.t });
  const run = async (purpose: 'read' | 'send') => {
    const s = await consent.begin({ purpose, redirectUri: REDIRECT, client: 'desktop' });
    const state = new URL(s.authUrl).searchParams.get('state') as string;
    return consent.complete(s.flowId, sealHandoff(sealer, s.flowId, s.sealTo, { state, redirectUri: REDIRECT, code: 'c' }));
  };
  return { fake, kit, consent, run };
}

test('a sign-in for another Google account is refused, its grant revoked, and the connected account left as it was', async () => {
  const r = await consentRig(record(), {
    body: {
      access_token: 'a2',
      refresh_token: 'other-refresh',
      expires_in: 3600,
      scope: READ_SCOPES.join(' '),
      id_token: idToken('someone-else@example.com'),
    },
  });
  try {
    await assert.rejects(r.run('read'), code('different_account'));
    assert.equal(r.kit.file.value?.email, 'me@example.com');
    assert.equal(r.kit.file.value?.tokens.refreshToken, 'rt');
    assert.equal(r.fake.requests.find((q) => q.path === '/revoke')?.form.get('token'), 'other-refresh');
  } finally {
    await r.fake.close();
  }
});

test('the same account signing in again keeps its connect day and a read sign-in does not claim a send grant it does not hold', async () => {
  const sent = record({
    connectedAt: NOW - 10 * DAY,
    grantedAt: NOW - 10 * DAY,
    tokens: { ...record().tokens, scopes: [...READ_SCOPES, SEND_SCOPE] },
  });
  const r = await consentRig(sent);
  try {
    r.kit.clock.t = NOW;
    assert.deepEqual(await r.run('read'), { email: 'me@example.com', canSend: false });
    assert.equal(r.kit.file.value?.connectedAt, NOW - 10 * DAY, 'the connect day is the first one');
    assert.equal(r.kit.file.value?.grantedAt, NOW, 'the grant is new');
    assert.equal(r.kit.file.value?.tokens.scopes.includes(SEND_SCOPE), false);
  } finally {
    await r.fake.close();
  }
});

test('testing-mode expiry counts from the grant, not from the first connect', async () => {
  const fake = await startFake(() => ({ status: 400, body: { error: 'invalid_grant' } }));
  try {
    const rec = record({ connectedAt: NOW - 30 * DAY, grantedAt: NOW - 1 * DAY });
    const { account } = makeAccount({
      config: fake.config,
      fetch: fake.fetch,
      file: memoryFile({ ...rec, tokens: { ...rec.tokens, expiresAt: 0 } }),
      testingMode: true,
    });
    await assert.rejects(
      account.accessToken(),
      (e: AccountError) => e.cause_ === 'revoked',
      'a day-old grant is not a testing-mode expiry',
    );
    const old = record({ connectedAt: NOW - 30 * DAY, grantedAt: NOW - 7 * DAY });
    const aged = makeAccount({
      config: fake.config,
      fetch: fake.fetch,
      file: memoryFile({ ...old, tokens: { ...old.tokens, expiresAt: 0 } }),
      testingMode: true,
    });
    await assert.rejects(aged.account.accessToken(), (e: AccountError) => e.cause_ === 'testing_expired');
  } finally {
    await fake.close();
  }
});

// nit: validate before burning a flow, and the oldest flow yields
test("a hand-off that is not the client's does not burn the flow; three of them do; the real one still works in between", async () => {
  const r = await consentRig(null as never);
  try {
    r.kit.file.value = null;
    const s = await r.consent.begin({ purpose: 'read', redirectUri: REDIRECT, client: 'desktop' });
    await assert.rejects(r.consent.complete(s.flowId, 'garbage'), code('invalid'));
    await assert.rejects(
      r.consent.complete(s.flowId, sealHandoff(sealer, s.flowId, s.sealTo, { state: 'wrong', redirectUri: REDIRECT, code: 'c' })),
      code('invalid'),
    );
    const state = new URL(s.authUrl).searchParams.get('state') as string;
    assert.equal(
      (await r.consent.complete(s.flowId, sealHandoff(sealer, s.flowId, s.sealTo, { state, redirectUri: REDIRECT, code: 'c' }))).email,
      'me@example.com',
    );
    const t = await r.consent.begin({ purpose: 'read', redirectUri: REDIRECT, client: 'desktop' });
    for (let i = 0; i < 3; i++) await assert.rejects(r.consent.complete(t.flowId, 'garbage'), code('invalid'));
    await assert.rejects(r.consent.complete(t.flowId, 'garbage'), code('unknown_flow'));
  } finally {
    await r.fake.close();
  }
});

test('a ninth sign-in pushes the oldest out instead of being refused', async () => {
  const r = await consentRig();
  try {
    const first = await r.consent.begin({ purpose: 'read', redirectUri: REDIRECT, client: 'desktop' });
    for (let i = 0; i < 8; i++) await r.consent.begin({ purpose: 'read', redirectUri: REDIRECT, client: 'desktop' });
    assert.equal(r.consent.pending(), 8);
    await assert.rejects(r.consent.complete(first.flowId, 'x'), code('unknown_flow'));
  } finally {
    await r.fake.close();
  }
});

// 5, 6. no token in an error; 403 reasons; backoff
const body = (status: number, reason: string) => ({ status, body: { error: { code: status, message: 'x', errors: [{ reason }] } } });
async function clientRig(
  answers: Array<FakeAnswer | undefined>,
  file = memoryFile(record({ tokens: { ...record().tokens, accessToken: SECRET } })),
) {
  let i = 0;
  const fake = await startFake((r) =>
    r.path === '/token'
      ? { body: { access_token: 'renewed', expires_in: 3600, scope: READ_SCOPES.join(' ') } }
      : (answers[Math.min(i++, answers.length - 1)] ?? { body: {} }),
  );
  const kit = makeAccount({ config: fake.config, fetch: fake.fetch, file });
  const sleeps: number[] = [];
  const client = createGoogleClient({
    account: kit.account,
    now: () => kit.clock.t,
    endpoints: { gmail: `${fake.url}/`, calendar: `${fake.url}/` },
    timeZone: 'UTC',
    sleep: async (ms: number) => void sleeps.push(ms),
  });
  return { fake, kit, client, sleeps, calls: () => fake.requests.filter((q) => q.path !== '/token').length };
}
const thread = { body: { id: 't1', messages: [] } };

test('an error from Google carries a status and a reason and no token, URL or request', async () => {
  const r = await clientRig([
    { status: 500, body: { error: { code: 500, message: `boom ${SECRET}`, errors: [{ reason: 'backendError' }] } } },
  ]);
  try {
    const e = await r.client.getThreadMeta('t1').catch((x: unknown) => x);
    assert.ok(e instanceof GoogleApiError);
    const seen = [e.message, e.stack, JSON.stringify(e), ...Object.getOwnPropertyNames(e).map((k) => String((e as never)[k]))].join('\n');
    for (const secret of [SECRET, 'Bearer', r.fake.url, 'authorization'])
      assert.ok(!seen.toLowerCase().includes(secret.toLowerCase()), `the error says ${secret}`);
    assert.deepEqual([e.status, e.reason], [500, 'backendError']);
  } finally {
    await r.fake.close();
  }
});

test('rate limits and server errors are waited out with a growing pause and then read; the grant is untouched', async () => {
  const r = await clientRig([body(403, 'rateLimitExceeded'), body(429, 'rateLimitExceeded'), body(503, 'backendError'), thread]);
  try {
    assert.equal((await r.client.getThreadMeta('t1'))?.id, 't1');
    assert.deepEqual(r.sleeps, [1000, 2000, 4000]);
    assert.equal(r.calls(), 4);
    assert.equal((await r.kit.account.status()).state, 'connected');
    const stuck = await clientRig([body(429, 'rateLimitExceeded')]);
    await assert.rejects(stuck.client.getThreadMeta('t1'), (e: GoogleApiError) => e.status === 429);
    assert.equal(stuck.calls(), 4, 'one try and three retries');
    assert.equal((await stuck.kit.account.status()).state, 'connected');
    await stuck.fake.close();
  } finally {
    await r.fake.close();
  }
});

test('a 403 ends the grant only when Google says a scope is missing', async () => {
  const forbidden = await clientRig([body(403, 'forbidden')]);
  const scope = await clientRig([body(403, 'insufficientPermissions')]);
  try {
    await assert.rejects(forbidden.client.getThreadMeta('t'), (e: GoogleApiError) => e.status === 403 && e.reason === 'forbidden');
    assert.equal((await forbidden.kit.account.status()).state, 'connected');
    await assert.rejects(scope.client.getThreadMeta('t'), (e: AccountError) => e.cause_ === 'scope_missing');
    assert.equal((await scope.kit.account.status()).state, 'needs_sign_in');
  } finally {
    await forbidden.fake.close();
    await scope.fake.close();
  }
});

test('a 401 gets one new access token; refused again, the grant is over', async () => {
  const ok = await clientRig([{ status: 401, body: { error: { code: 401 } } }, thread]);
  const dead = await clientRig([{ status: 401, body: { error: { code: 401 } } }]);
  try {
    assert.equal((await ok.client.getThreadMeta('t1'))?.id, 't1');
    assert.equal(ok.fake.requests.filter((q) => q.path === '/token').length, 1, 'a new token was asked for');
    await assert.rejects(dead.client.getThreadMeta('t1'), (e: AccountError) => e.cause_ === 'revoked');
    assert.equal(dead.fake.requests.filter((q) => q.path === '/token').length, 1);
  } finally {
    await ok.fake.close();
    await dead.fake.close();
  }
});

test('a send is never retried and its failure holds no token', async () => {
  const r = await clientRig([body(503, 'backendError')]);
  try {
    const grants = createSendGrants(() => NOW);
    r.kit.file.value = record({ tokens: { ...record().tokens, accessToken: SECRET, scopes: [...READ_SCOPES, SEND_SCOPE] } });
    const sender = createSender({ account: r.kit.account, redeem: grants.redeem, endpoint: `${r.fake.url}/` });
    const msg = { to: ['a@x.com'], subject: 's', body: 'b' };
    const out = await sender.send(msg, grants.mint(messageDigest(msg)));
    assert.deepEqual(out, { ok: false, reason: 'failed' });
    assert.equal(r.calls(), 1);
    assert.ok(!JSON.stringify(out).includes(SECRET));
    const tooBig = { ...msg, body: 'x'.repeat(100_001) };
    assert.deepEqual(await sender.send(tooBig, grants.mint(messageDigest(tooBig))), { ok: false, reason: 'invalid' });
    const crowd = { ...msg, to: Array.from({ length: 51 }, (_, i) => `a${i}@x.com`) };
    assert.deepEqual(await sender.send(crowd, grants.mint(messageDigest(crowd))), { ok: false, reason: 'invalid' });
    const subject = { ...msg, subject: 's'.repeat(501) };
    assert.deepEqual(await sender.send(subject, grants.mint(messageDigest(subject))), { ok: false, reason: 'invalid' });
  } finally {
    await r.fake.close();
  }
});

// 7. HTML limits
test('HTML to text is linear, drops style, script and comments, and keeps a lone "<"', () => {
  assert.equal(
    htmlToText('<p>Hello&nbsp;<b>there</b></p><style>p{x:1}</style><script>evil()</script><!-- hidden -->after'),
    'Hello there after',
  );
  assert.equal(htmlToText('1 < 2 and 3 <4> 5 <b>x</b>'), '1 < 2 and 3 <4> 5 x');
  assert.equal(htmlToText('<style>never closed'), '');
  assert.equal(htmlToText('<!-- never closed'), '');
  assert.equal(htmlToText('text <b never closed'), 'text');
  assert.equal(htmlToText('<SCRIPT>x</SCRIPT>ok'), 'ok');
  const started = Date.now();
  htmlToText(`${'<'.repeat(300_000)}${'<style>'.repeat(20_000)}${'<a '.repeat(50_000)}`);
  assert.ok(Date.now() - started < 1500, 'pathological input is read in linear time');
});

test('a huge mail part is cut before anything decodes or scans it', async () => {
  const huge = Buffer.from(`<p>${'<style>x</style>'.repeat(300_000)}tail</p>`).toString('base64url');
  const r = await clientRig([
    { body: { id: 't1', messages: [{ id: 'm', internalDate: String(NOW), payload: { mimeType: 'text/html', body: { data: huge } } }] } },
  ]);
  try {
    const started = Date.now();
    const mail = await r.client.getMail('t1');
    assert.ok((mail?.body.length ?? 0) <= BODY_CAP);
    assert.ok(!mail?.body.includes('tail'), 'the part was cut at its cap');
    assert.ok(Date.now() - started < 2000);
  } finally {
    await r.fake.close();
  }
});

// nit: cursors are pruned and written in batches
test('cursors: the oldest are pruned, writes are batched, and a discard writes nothing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'momo-cursors-'));
  const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
  const safe: SafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (t) => xor(Buffer.from(t)),
    decryptString: (b) => xor(b).toString('utf8'),
  };
  let writes = 0;
  const counting = {
    ...io,
    writeFile: (async (...a: Parameters<typeof io.writeFile>) => (writes++, io.writeFile(...a))) as typeof io.writeFile,
  };
  const store = createVersionStore(dir, safe, counting, { delayMs: 10_000, max: 3 });
  for (const k of ['a', 'b', 'c', 'd']) await store.set(k, '1');
  await store.set('b', '2');
  assert.equal(writes, 0, 'nothing is written per set');
  assert.deepEqual(
    [await store.get('a'), await store.get('b'), await store.get('c'), await store.get('d')],
    [undefined, '2', '1', '1'],
    'the oldest was pruned, a touched one is newest',
  );
  await store.flush();
  assert.equal(writes, 1);
  const again = createVersionStore(dir, safe, io, { delayMs: 10_000 });
  assert.equal(await again.get('b'), '2');
  await again.set('z', '9');
  again.discard();
  assert.equal(await createVersionStore(dir, safe, io).get('z'), undefined, 'a discarded change is never written');
  const quick = createVersionStore(dir, safe, io, { delayMs: 5 });
  await quick.set('t', '1');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(await createVersionStore(dir, safe, io).get('t'), '1', 'the timer writes the batch');
});

test('a timed write that fails is reported, not lost silently', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'momo-cursors-'));
  const safe: SafeStorage = {
    isEncryptionAvailable: () => false,
    encryptString: (t) => Buffer.from(t),
    decryptString: (b) => b.toString(),
  };
  const errors: unknown[] = [];
  const store = createVersionStore(
    dir,
    { ...safe, isEncryptionAvailable: () => true },
    {
      ...io,
      writeFile: (async () => {
        throw new Error('disk full');
      }) as typeof io.writeFile,
    },
    { delayMs: 5, report: (e) => errors.push(e) },
  );
  await store.set('k', 'v');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.match(String((errors[0] as Error).message), /disk full/);
});

// nit: the Mac catcher only accepts the redirect of the page it opened
const get = (url: string) =>
  new Promise<number>((resolve, reject) => http.get(url, (res) => (res.resume(), resolve(res.statusCode as number))).on('error', reject));

test('a request to the loopback with another state, or before a page is opened, does not end the wait', async () => {
  const catcher = await createLoopbackCatcher({ openExternal: () => undefined })();
  assert.equal(await get(`${catcher.redirectUri}?state=anything&code=forged`), 400, 'before open there is no expected state');
  await catcher.open('https://accounts.example/auth?state=real-state');
  assert.equal(await get(`${catcher.redirectUri}?state=other&code=forged`), 400);
  const waiting = catcher.wait();
  assert.equal(await get(`${catcher.redirectUri}?state=real-state&code=good`), 200);
  assert.deepEqual(await waiting, { state: 'real-state', redirectUri: catcher.redirectUri, code: 'good' });
});

test('a consent page opened with no state is never matched', async () => {
  const catcher = await createLoopbackCatcher({ openExternal: () => undefined })();
  await catcher.open('https://accounts.example/auth');
  assert.equal(await get(`${catcher.redirectUri}?state=x&code=c`), 400);
  catcher.close();
  assert.equal(await catcher.wait(), null);
});

test('an API failure is read down to a status and a reason word, whatever the raw error held', () => {
  assert.deepEqual(
    readError({
      status: 403,
      response: { data: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } },
      config: { headers: { Authorization: `Bearer ${SECRET}` } },
    }),
    { status: 403, reason: 'rateLimitExceeded' },
  );
  assert.deepEqual(readError({ status: 500 }), { status: 500, reason: '' });
  assert.deepEqual(readError(new Error('ECONNRESET')), { status: 0, reason: '' });
  assert.deepEqual(readError(null), { status: 0, reason: '' });
  assert.equal(readError({ status: 400, response: { data: { error: { errors: [{ reason: 'x'.repeat(200) }] } } } }).reason.length, 64);
  assert.deepEqual(readError({ status: 400, response: { data: { error: { errors: [{ reason: 7 }] } } } }), { status: 400, reason: '' });
  assert.equal(new GoogleApiError(0, '').message, 'Google could not be reached');
  assert.equal(new GoogleApiError(500, '').message, 'Google answered 500');
  assert.equal(isRetryable({ status: 403, reason: 'userRateLimitExceeded' }), true);
  assert.equal(isRetryable({ status: 403, reason: 'forbidden' }), false);
  assert.equal(isRetryable({ status: 400, reason: '' }), false);
  assert.equal(isScopeProblem({ status: 403, reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }), true);
  assert.equal(isScopeProblem({ status: 401, reason: 'insufficientPermissions' }), false);
});

test('a network failure is a retried then thrown "could not be reached", with nothing of the request', async () => {
  const r = await clientRig([{ body: {} }]);
  await r.fake.close();
  const e = await r.client.getThreadMeta('t1').catch((x: unknown) => x);
  assert.ok(e instanceof GoogleApiError);
  assert.deepEqual([e.status, e.message], [0, 'Google could not be reached']);
  assert.equal(r.sleeps.length, 0, 'a status of 0 is not a reason to wait');
});

test('HTML that ends in a bare "<" keeps it', () => {
  assert.equal(htmlToText('end <'), 'end <');
});

test('a timed cursor write that fails with no one listening does not escape', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'momo-cursors-'));
  const safe: SafeStorage = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(t), decryptString: (b) => b.toString() };
  const store = createVersionStore(
    dir,
    safe,
    {
      ...io,
      writeFile: (async () => {
        throw new Error('disk full');
      }) as typeof io.writeFile,
    },
    { delayMs: 5 },
  );
  await store.set('k', 'v');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(await store.get('k'), 'v', 'the change is still in memory');
});

test('delay waits and then resolves', async () => {
  const t = Date.now();
  await delay(15);
  assert.ok(Date.now() - t >= 10);
});

test('an account is the same by its Google id, not its address: a renamed address keeps the account, an ID token with no id is no sign-in', async () => {
  const claims = (c: object) => `x.${Buffer.from(JSON.stringify(c)).toString('base64url')}.y`;
  const renamed = await consentRig(record({ connectedAt: NOW - 3 * DAY }), {
    body: {
      access_token: 'a2',
      refresh_token: 'r2',
      expires_in: 3600,
      scope: READ_SCOPES.join(' '),
      id_token: claims({ email: 'new-name@example.com', sub: 'sub-me@example.com' }),
    },
  });
  const noId = await consentRig(record(), {
    body: {
      access_token: 'a2',
      refresh_token: 'r2',
      expires_in: 3600,
      scope: READ_SCOPES.join(' '),
      id_token: claims({ email: 'me@example.com' }),
    },
  });
  try {
    assert.equal((await renamed.run('read')).email, 'new-name@example.com');
    assert.equal(renamed.kit.file.value?.connectedAt, NOW - 3 * DAY);
    await assert.rejects(noId.run('read'), code('exchange_failed'));
  } finally {
    await renamed.fake.close();
    await noId.fake.close();
  }
});
