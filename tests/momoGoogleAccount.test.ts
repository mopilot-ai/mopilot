// MoMo Google account (shared/momoGoogle/account.ts, clientConfig.ts): refresh, single flight, disconnected causes, disconnect with revoke, move export/import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountError } from '../shared/momoGoogle/account.mjs';
import { iosClientConfig, iosRedirect, loadClientConfig, parseClientConfig } from '../shared/momoGoogle/clientConfig.mjs';
import { READ_SCOPES, SEND_SCOPE } from '../shared/momoGoogle/types.mjs';
import { startFake } from './support/fakeGoogle.ts';
import { makeAccount, memoryFile, NOW, record } from './support/googleAccountKit.ts';

const DAY = 86_400_000;

test('a token with time left is used as is; one near its end is refreshed once for concurrent callers', async () => {
  let refreshes = 0;
  const fake = await startFake((r) => {
    if (r.path !== '/token') return undefined;
    refreshes++;
    assert.equal(r.form.get('grant_type'), 'refresh_token');
    assert.equal(r.form.get('refresh_token'), 'rt');
    assert.equal(r.form.get('client_secret'), 'client-secret');
    return { body: { access_token: 'fresh', expires_in: 3600, scope: READ_SCOPES.join(' ') } };
  });
  try {
    const { account, file, clock } = makeAccount({ config: fake.config, fetch: fake.fetch });
    assert.equal(await account.accessToken(), 'at');
    assert.equal(refreshes, 0);
    clock.t = NOW + 3_590_000;
    assert.deepEqual(await Promise.all([account.accessToken(), account.accessToken()]), ['fresh', 'fresh']);
    assert.equal(refreshes, 1);
    assert.deepEqual(file.value?.tokens.scopes, [...READ_SCOPES]);
    assert.equal(file.value?.tokens.refreshToken, 'rt', 'Google sent no new refresh token: the old one stays');
    assert.equal(file.value?.tokens.expiresAt, clock.t + 3_600_000);
  } finally {
    await fake.close();
  }
});

test('a refresh that returns a new refresh token, no expiry and no scope keeps what it must', async () => {
  const fake = await startFake(() => ({ body: { access_token: 'fresh', refresh_token: 'rt2', expires_in: 'soon' } }));
  try {
    const { account, file, clock } = makeAccount({ config: fake.config, fetch: fake.fetch });
    clock.t = NOW + DAY;
    await account.accessToken();
    assert.equal(file.value?.tokens.refreshToken, 'rt2');
    assert.equal(file.value?.tokens.expiresAt, clock.t + 3_600_000);
    assert.equal(file.value?.tokens.scopes.length, 4);
  } finally {
    await fake.close();
  }
});

test('invalid_grant ends the source with a cause, then every read says so without calling Google', async () => {
  const fake = await startFake(() => ({ status: 400, body: { error: 'invalid_grant' } }));
  try {
    const young = makeAccount({ config: fake.config, fetch: fake.fetch, testingMode: true });
    young.clock.t = NOW + 2 * DAY;
    await assert.rejects(young.account.accessToken(), (e: AccountError) => e.code === 'needs_sign_in' && e.cause_ === 'revoked');
    assert.deepEqual(await young.account.status(), {
      state: 'needs_sign_in',
      email: 'me@example.com',
      cause: 'revoked',
      since: NOW + 2 * DAY,
    });
    const calls = fake.requests.length;
    await assert.rejects(young.account.accessToken(), /needs a new sign-in \(revoked\)/);
    assert.equal(fake.requests.length, calls);

    const old = makeAccount({ config: fake.config, fetch: fake.fetch, testingMode: true });
    old.clock.t = NOW + 7 * DAY;
    await assert.rejects(old.account.accessToken(), (e: AccountError) => e.cause_ === 'testing_expired');

    const production = makeAccount({ config: fake.config, fetch: fake.fetch });
    production.clock.t = NOW + 7 * DAY;
    await assert.rejects(production.account.accessToken(), (e: AccountError) => e.cause_ === 'revoked');
  } finally {
    await fake.close();
  }
});

test('a rejected client ends the source; a 5xx, a network failure or a malformed answer does not', async () => {
  let answer: any = { status: 401, body: { error: 'invalid_client' } };
  const fake = await startFake(() => answer);
  try {
    const rejected = makeAccount({ config: fake.config, fetch: fake.fetch });
    rejected.clock.t = NOW + DAY;
    await assert.rejects(rejected.account.accessToken(), (e: AccountError) => e.cause_ === 'client_rejected');

    for (const a of [
      { status: 503, body: { error: 'backend_error' } },
      { status: 200, body: {} },
    ]) {
      answer = a;
      const m = makeAccount({ config: fake.config, fetch: fake.fetch });
      m.clock.t = NOW + DAY;
      await assert.rejects(
        m.account.accessToken(),
        (e: AccountError) => e.code === 'unavailable' && /could not be reached/.test(e.message),
      );
      assert.equal((await m.account.status()).state, 'connected');
    }
    const down = makeAccount({
      config: fake.config,
      fetch: async () => {
        throw new Error('offline');
      },
    });
    down.clock.t = NOW + DAY;
    await assert.rejects(down.account.accessToken(), (e: AccountError) => e.code === 'unavailable');

    answer = { status: 200 };
    const html = makeAccount({
      config: fake.config,
      fetch: async () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error('html');
        },
      }),
    });
    html.clock.t = NOW + DAY;
    await assert.rejects(html.account.accessToken(), (e: AccountError) => e.code === 'unavailable');
  } finally {
    await fake.close();
  }
});

test('with nothing connected: status, token and markNeedsSignIn', async () => {
  const fake = await startFake(() => undefined);
  try {
    const { account } = makeAccount({ config: fake.config, fetch: fake.fetch, file: memoryFile() });
    assert.deepEqual(await account.status(), { state: 'not_connected' });
    await assert.rejects(account.accessToken(), (e: AccountError) => e.code === 'not_connected' && /not connected/.test(e.message));
    await account.markNeedsSignIn('revoked', account.generation());
    assert.deepEqual(await account.status(), { state: 'not_connected' });
  } finally {
    await fake.close();
  }
});

test('connected status says whether sending was granted; connect clears a needs-sign-in state', async () => {
  const fake = await startFake(() => undefined);
  try {
    const { account, file } = makeAccount({ config: fake.config, fetch: fake.fetch });
    assert.deepEqual(await account.status(), { state: 'connected', email: 'me@example.com', canSend: false, connectedAt: NOW });
    await account.markNeedsSignIn('scope_missing', account.generation());
    assert.equal((await account.status()).state, 'needs_sign_in');
    await account.connect({
      email: 'me@example.com',
      subject: 'sub-me@example.com',
      tokens: { ...record().tokens, scopes: [SEND_SCOPE] },
      client: 'desktop',
      rule: 'send',
      generation: account.generation(),
    });
    assert.deepEqual(await account.status(), { state: 'connected', email: 'me@example.com', canSend: true, connectedAt: NOW });
    assert.equal(file.value?.needsSignIn, undefined);
  } finally {
    await fake.close();
  }
});

test('disconnect revokes the refresh token at Google and erases the account whatever Google says', async () => {
  const fake = await startFake((r) => (r.path === '/revoke' ? { body: {} } : undefined));
  try {
    const ok = makeAccount({ config: fake.config, fetch: fake.fetch });
    assert.deepEqual(await ok.account.disconnect(), { revoked: true, owedToken: null });
    assert.equal(fake.requests[0]?.form.get('token'), 'rt');
    assert.equal(ok.file.value, null);

    const refused = makeAccount({ config: { ...fake.config, revokeUri: `${fake.url}/nope` }, fetch: fake.fetch });
    assert.deepEqual(await refused.account.disconnect(), { revoked: false, owedToken: 'rt' });
    assert.equal(refused.file.value, null);

    const offline = makeAccount({
      config: fake.config,
      fetch: async () => {
        throw new Error('offline');
      },
    });
    assert.deepEqual(await offline.account.disconnect(), { revoked: false, owedToken: 'rt' });
    assert.equal(offline.file.value, null);

    const none = makeAccount({ config: fake.config, fetch: fake.fetch, file: memoryFile() });
    assert.deepEqual(await none.account.disconnect(), { revoked: false, owedToken: null });

    // the revoke is asked while the record still exists (so a failure leaves something to keep owed); Google's 400 says the token was already gone
    let during: unknown = 'not asked';
    const first = makeAccount({
      config: fake.config,
      fetch: (async () => {
        during = first.file.value?.tokens.refreshToken;
        return new Response('{"error":"invalid_token"}', { status: 400 });
      }) as typeof fetch,
    });
    assert.deepEqual(await first.account.disconnect(), { revoked: true, owedToken: null });
    assert.equal(during, 'rt');
    assert.equal(first.file.value, null);
  } finally {
    await fake.close();
  }
});

test('the client file is read by path into a config, and a bad file says what is missing without echoing it', async () => {
  const good = JSON.stringify({ installed: { client_id: 'id', client_secret: 'sec', auth_uri: 'https://a', token_uri: 'https://t' } });
  assert.deepEqual(parseClientConfig(good), {
    clientId: 'id',
    clientSecret: 'sec',
    authUri: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUri: 'https://oauth2.googleapis.com/token',
    revokeUri: 'https://oauth2.googleapis.com/revoke',
  });
  let asked = '';
  assert.equal(
    (
      await loadClientConfig('/p/client.json', async (p) => {
        asked = p;
        return good;
      })
    ).clientId,
    'id',
  );
  assert.equal(asked, '/p/client.json');
  assert.throws(
    () => parseClientConfig('not json sec'),
    (e: Error) => e.message === 'The Google client file is not JSON',
  );
  assert.throws(() => parseClientConfig('{}'), /no client_id/);
  assert.throws(
    () => parseClientConfig(JSON.stringify({ installed: { client_id: 'id' } })),
    (e: Error) => /no client_secret/.test(e.message) && !e.message.includes('id'),
  );
});

test('an iOS grant is refreshed with the iOS client and no secret; without that client here it needs a new sign-in', async () => {
  const fake = await startFake((r) =>
    r.path === '/token' ? { body: { access_token: 'ios-fresh', expires_in: 3600, scope: READ_SCOPES.join(' ') } } : undefined,
  );
  try {
    const iosConfig = { ...iosClientConfig('ios-client-123456.apps.googleusercontent.com'), tokenUri: fake.config.tokenUri };
    const withIos = makeAccount({ config: fake.config, iosConfig, fetch: fake.fetch, file: memoryFile(record({ client: 'ios' })) });
    withIos.clock.t = NOW + DAY;
    assert.equal(await withIos.account.accessToken(), 'ios-fresh');
    assert.equal(fake.requests[0]?.form.get('client_id'), iosConfig.clientId);
    assert.equal(fake.requests[0]?.form.has('client_secret'), false);

    const without = makeAccount({ config: fake.config, fetch: fake.fetch, file: memoryFile(record({ client: 'ios' })) });
    without.clock.t = NOW + DAY;
    await assert.rejects(without.account.accessToken(), (e: AccountError) => e.cause_ === 'client_rejected');
    assert.equal((await without.account.status()).state, 'needs_sign_in');
    assert.equal(fake.requests.length, 1);
  } finally {
    await fake.close();
  }
});

test('the iOS client config is an id with no secret, and its redirect is the reversed id as a scheme', () => {
  const c = iosClientConfig('ios-client-123456.apps.googleusercontent.com');
  assert.deepEqual(
    [c.clientSecret, c.tokenUri, c.authUri.startsWith('https://accounts.google.com/')],
    ['', 'https://oauth2.googleapis.com/token', true],
  );
  assert.equal(iosRedirect('ios-client-123456'), 'com.googleusercontent.apps.ios-client-123456:/oauth2redirect');
  assert.throws(() => iosClientConfig('x y'), /not an id/);
});
