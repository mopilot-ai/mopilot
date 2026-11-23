// MoMo's Google sign-in on the clients: the typed states (shared/momoGoogle/state.mjs), the Mac's loopback catcher (electron/momo/googleCatcher.cjs) and the phone's app-scheme session catcher (mobile/src/momo/googleCatcher.ts), each ending in the same hand-off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createAuthSessionCatcher } from '../mobile/src/momo/googleCatcher.ts';
import { DISCONNECT_CAUSES, googleStateOf } from '../shared/momoGoogle/state.mjs';
import { causeOf, GOOGLE_INTENTS, runGoogleIntent, setupGoogleOf, sourcesOf } from '../shared/momoGoogle/view.mjs';
import { createSealer } from '../shared/momoGoogle/seal.mjs';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';

const require = createRequire(import.meta.url);
const sealer = createSealer(createNodePrimitives());
const { createLoopbackCatcher } = require('../electron/momo/googleCatcher.cjs');

const none = { desktop: false, iosRedirectUri: null };

test('the five states: not connected (with what can start), connecting, read only, send granted, disconnected with its cause', () => {
  assert.deepEqual(googleStateOf({ status: { state: 'not_connected' }, pending: 0, configured: none }), {
    kind: 'not_connected',
    canStart: false,
    iosRedirectUri: null,
  });
  assert.deepEqual(
    googleStateOf({ status: { state: 'not_connected' }, pending: 0, configured: { desktop: true, iosRedirectUri: 'x:/cb' } }),
    { kind: 'not_connected', canStart: true, iosRedirectUri: 'x:/cb' },
  );
  assert.deepEqual(googleStateOf({ status: { state: 'not_connected' }, pending: 2, configured: none }), { kind: 'connecting' });
  const connected = { state: 'connected' as const, email: 'me@example.com', connectedAt: 5 };
  assert.deepEqual(googleStateOf({ status: { ...connected, canSend: false }, pending: 1, configured: none }), {
    kind: 'connected_read_only',
    email: 'me@example.com',
    connectedAt: 5,
  });
  assert.deepEqual(googleStateOf({ status: { ...connected, canSend: true }, pending: 0, configured: none }), {
    kind: 'send_granted',
    email: 'me@example.com',
    connectedAt: 5,
  });
  assert.deepEqual(
    googleStateOf({
      status: { state: 'needs_sign_in', email: 'me@example.com', cause: 'testing_expired', since: 9 },
      pending: 1,
      configured: none,
    }),
    { kind: 'disconnected', email: 'me@example.com', cause: 'testing_expired', since: 9 },
  );
  assert.deepEqual([...DISCONNECT_CAUSES], ['revoked', 'testing_expired', 'scope_missing', 'client_rejected', 'wrong_account']);
});

/** What the system browser does after consent: a GET to the redirect. */
const get = (url: string, method = 'GET') =>
  new Promise<number>((resolve, reject) => {
    http
      .request(url, { method }, (res) => (res.resume(), resolve(res.statusCode as number)))
      .on('error', reject)
      .end();
  });

test('the Mac catcher answers only the one redirect with a state and a code or error, then closes; other requests change nothing', async () => {
  const opened: string[] = [];
  const catcher = await createLoopbackCatcher({ openExternal: (u: string) => void opened.push(u) })();
  assert.match(catcher.redirectUri, /^http:\/\/127\.0\.0.1:\d+\/callback$/);
  await catcher.open('https://accounts.example/auth?x=1&state=s');
  assert.deepEqual(opened, ['https://accounts.example/auth?x=1&state=s']);
  assert.equal(await get(`${catcher.redirectUri}?code=c`), 400, 'no state');
  assert.equal(await get(catcher.redirectUri.replace('/callback', '/other?state=s&code=c')), 404);
  assert.equal(await get(`${catcher.redirectUri}?state=s&code=c`, 'POST'), 404);
  const waiting = catcher.wait();
  assert.equal(await get(`${catcher.redirectUri}?state=s&code=the-code`), 200);
  assert.deepEqual(await waiting, { state: 's', redirectUri: catcher.redirectUri, code: 'the-code' });
  assert.notEqual(
    await get(`${catcher.redirectUri}?state=s&code=again`).catch(() => 'refused'),
    200,
    'a second redirect is refused or told it is gone',
  );
  catcher.close();
});

test('the Mac catcher gives an error redirect, and null when closed or timed out', async () => {
  const withError = await createLoopbackCatcher({ openExternal: () => undefined })();
  await withError.open('https://accounts.example/auth?state=s');
  await get(`${withError.redirectUri}?state=s&error=access_denied`);
  assert.deepEqual(await withError.wait(), { state: 's', redirectUri: withError.redirectUri, error: 'access_denied' });
  const closed = await createLoopbackCatcher({ openExternal: () => undefined })();
  closed.close();
  assert.equal(await closed.wait(), null);
  const slow = await createLoopbackCatcher({ openExternal: () => undefined, timeoutMs: 10 })();
  assert.equal(await slow.wait(), null);
});

test('a request that races a finished catcher is told it is gone, and a listener that cannot start rejects', async () => {
  let handler: any;
  const failing = new EventEmitter() as any;
  failing.listen = () => failing.emit('error', new Error('EADDRINUSE'));
  failing.close = () => undefined;
  await assert.rejects(createLoopbackCatcher({ openExternal: () => undefined, http: { createServer: () => failing } })(), /EADDRINUSE/);
  const fake = new EventEmitter() as any;
  fake.listen = (_p: number, _h: string, cb: () => void) => cb();
  fake.address = () => ({ port: 4000 });
  fake.close = () => undefined;
  const c = await createLoopbackCatcher({ openExternal: () => undefined, http: { createServer: (h: any) => ((handler = h), fake) } })();
  c.close();
  const seen: number[] = [];
  const res = { writeHead: (s: number) => (seen.push(s), { end: () => undefined }) };
  handler({ method: 'GET', url: '/callback?state=s&code=c' }, res);
  assert.deepEqual(seen, [410]);
});

test("the phone catcher opens the consent in the system session on the home's iOS redirect and returns what came back", async () => {
  const ios = 'com.googleusercontent.apps.123-abc:/oauth2redirect';
  const opened: [string, string][] = [];
  const catcher = await createAuthSessionCatcher({
    redirectUri: ios,
    openAuthSession: async (url, redirect) => (opened.push([url, redirect]), { type: 'success', url: `${ios}?state=s&code=c` }),
  })();
  assert.equal(catcher.redirectUri, ios);
  await catcher.open('https://accounts.example/auth?state=s');
  assert.deepEqual(opened, [['https://accounts.example/auth?state=s', ios]]);
  assert.deepEqual(await catcher.wait(), { state: 's', redirectUri: ios, code: 'c' });
  catcher.close();
  for (const type of ['cancel', 'dismiss'] as const) {
    const c = await createAuthSessionCatcher({ redirectUri: ios, openAuthSession: async () => ({ type }) })();
    await c.open('https://accounts.example/auth?state=s');
    assert.equal(await c.wait(), null);
  }
  const unopened = await createAuthSessionCatcher({ redirectUri: ios, openAuthSession: async () => ({ type: 'cancel' }) })();
  assert.equal(await unopened.wait(), null, 'a wait with no open is a cancel, never a hang');
});

const read = { kind: 'connected_read_only' as const, email: 'me@example.com', connectedAt: 5 };
const lost = { kind: 'disconnected' as const, email: 'me@example.com', cause: 'testing_expired', since: 9 };

test('the view rows: nothing before a connect, two rows when connected, read-and-ask once sending is granted, needs-reconnect with its cause, catching-up with progress', () => {
  assert.deepEqual(sourcesOf({ kind: 'not_connected', canStart: true, iosRedirectUri: null }), []);
  assert.deepEqual(sourcesOf({ kind: 'connecting' }), []);
  assert.deepEqual(
    sourcesOf(read).map((r) => [r.id, r.account, r.access, r.status, r.progress]),
    [
      ['gmail', 'me@example.com', 'read-only', 'ok', null],
      ['calendar', 'me@example.com', 'read-only', 'ok', null],
    ],
  );
  assert.equal(sourcesOf({ ...read, kind: 'send_granted' })[0]?.access, 'read-and-ask');
  assert.deepEqual(sourcesOf(read, { done: 3, total: 10 })[1], {
    id: 'calendar',
    account: 'me@example.com',
    access: 'read-only',
    status: 'catching-up',
    progress: { done: 3, total: 10 },
  });
  assert.deepEqual(
    sourcesOf(lost, { done: 1, total: 2 }).map((r) => [r.status, r.progress]),
    [
      ['needs-reconnect', null],
      ['needs-reconnect', null],
    ],
  );
  assert.equal(causeOf(lost), 'testing_expired');
  assert.equal(causeOf(read), null);
});

test('the setup line says waiting, connected, or failed, and idle before the first try', () => {
  const none = { kind: 'not_connected' as const, canStart: true, iosRedirectUri: null };
  assert.deepEqual(
    [
      setupGoogleOf(none, false),
      setupGoogleOf(none, true),
      setupGoogleOf({ kind: 'connecting' }, false),
      setupGoogleOf(read, true),
      setupGoogleOf(lost, false),
    ],
    ['idle', 'failed', 'waiting', 'connected', 'failed'],
  );
});

test('the four intents run against the home, and an unknown one is answered and never runs', async () => {
  const calls: [string, object?][] = [];
  const host = {
    call: async (op: string, p?: object) => {
      calls.push([op, p]);
      if (op === 'begin')
        return { flowId: 'f'.repeat(16), authUrl: 'https://accounts.example/auth', sealTo: sealer.generateKeyPair().publicKey };
      if (op === 'disconnect') return { revoked: true, state: { kind: 'not_connected', canStart: true, iosRedirectUri: null } };
      return read;
    },
  };
  const catcher = async () => ({
    redirectUri: 'http://127.0.0.1:1/callback',
    open: async () => undefined,
    wait: async () => ({ state: 's', redirectUri: 'http://127.0.0.1:1/callback', code: 'c' }),
    close: () => undefined,
  });
  const run = (intent: string) => runGoogleIntent({ intent, host, startCatcher: catcher, sealer, client: 'desktop' });
  assert.deepEqual([...GOOGLE_INTENTS], ['connect', 'reconnect', 'grant-send', 'remove']);
  for (const intent of ['connect', 'reconnect']) assert.deepEqual(await run(intent), { ok: true, state: read });
  await run('grant-send');
  assert.deepEqual(
    calls.filter(([op]) => op === 'begin').map(([, p]) => (p as any).purpose),
    ['read', 'read', 'send'],
  );
  assert.deepEqual(await run('remove'), {
    ok: true,
    revoked: true,
    state: { kind: 'not_connected', canStart: true, iosRedirectUri: null },
  });
  const before = calls.length;
  assert.deepEqual(await run('format-disk'), {
    ok: false,
    code: 'unknown_intent',
    message: 'That is not something MoMo can do with Google.',
  });
  assert.equal(calls.length, before);
});

test('the phone catcher ignores a redirect that does not carry the state of the page it opened', async () => {
  const ios = 'com.googleusercontent.apps.123-abc:/oauth2redirect';
  const c = await createAuthSessionCatcher({
    redirectUri: ios,
    openAuthSession: async () => ({ type: 'success', url: `${ios}?state=forged&code=c` }),
  })();
  await c.open('https://accounts.example/auth?state=real');
  assert.equal(await c.wait(), null);
});
