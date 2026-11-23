// OAuth 2.1 tokens after the sign-in (electron/gateway/oauthTokens.cjs, service.cjs, #2999 C2b) against a real authorization server and protected MCP server on 127.0.0.1: refreshed 60 s before expiry (half the life of a short-lived token) and on a 401, one refresh per saved sign-in, bounded; a refused refresh, or a sign-out by another MoPilot, ends the sign-in and the server shows it at once (no tools, needs_credentials); a failed one keeps it; a refresh that settles after a newer sign-in or a sign-out never overwrites it (A4); calls in flight when a sign-in ends come back stale; the token goes only to the server's origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeSafe } from './support/momo-fixtures.ts';
import { gatewayDir, tick } from './support/gatewayWorld.ts';
import { oauthWorld } from './support/gatewayOAuthServer.ts';

const require = createRequire(import.meta.url);
const { Gateway } = require('../electron/gateway/service.cjs');
const { OAuthTokens, REFRESH_EARLY_MS } = require('../electron/gateway/oauthTokens.cjs');
const { oauthCredentialOf, metadataOf, endpoint } = require('../electron/gateway/oauthCredential.cjs');
const { CredentialVault } = require('../electron/gateway/credentials.cjs');

const settled = async () => {
  for (let i = 0; i < 40; i++) await tick();
};

async function signedIn(o: Parameters<typeof oauthWorld>[0] = {}) {
  const w = await oauthWorld(o);
  const clock = { t: 1_000_000 };
  const gateway = new Gateway({ dir: gatewayDir(), safeStorage: fakeSafe(), now: () => clock.t });
  const { key } = await gateway.add({ name: 'p', launch: { type: 'http', url: w.mcpUrl, headers: {} }, auth: 'oauth' });
  await settled();
  return { ...w, gateway, key, clock };
}

const row = (g: any) => g.view().servers[0];
const callMe = async (g: any, key: string) => {
  const r = g.upstreams.get(key);
  return (await g.upstreams.call(key, r.epoch, 'me', {}, { timeout: 5000, maxTotalTimeout: 5000 })).content[0].text;
};

test('the token is refreshed 60 s before it expires, not before; a 401 refreshes once and retries', async () => {
  const w = await signedIn();
  await w.gateway.signIn(w.key, w.browser);
  const refreshes = () => w.s.requests.filter((r: any) => r.form?.grant_type === 'refresh_token').length;
  // 61 s left: the saved token
  w.clock.t += 3600_000 - REFRESH_EARLY_MS - 1000;
  assert.equal(await callMe(w.gateway, w.key), 'as at-1');
  assert.equal(refreshes(), 0);
  // 59 s left: refreshed before the request
  w.clock.t += 2000;
  assert.equal(await callMe(w.gateway, w.key), 'as at-2');
  assert.equal(refreshes(), 1);
  assert.equal(w.gateway.credentials.get(w.key).refreshToken, 'rt-2');
  // the server stops taking the token early (revoked): one refresh, the request again
  w.s.revoked = new Set(['at-2']);
  assert.equal(await callMe(w.gateway, w.key), 'as at-3');
  assert.equal(refreshes(), 2);
  w.gateway.close();
});

test('A1: requests at once share one refresh', async () => {
  const w = await signedIn();
  await w.gateway.signIn(w.key, w.browser);
  w.clock.t += 3600_000;
  let release!: () => void;
  w.s.holdRefresh = new Promise<void>((r) => (release = r));
  const calls = [callMe(w.gateway, w.key), callMe(w.gateway, w.key), callMe(w.gateway, w.key)];
  await settled();
  release();
  assert.deepEqual(await Promise.all(calls), ['as at-2', 'as at-2', 'as at-2']);
  assert.equal(w.s.requests.filter((r: any) => r.form?.grant_type === 'refresh_token').length, 1);
  w.gateway.close();
});

test('a refresh the server refuses ends the sign-in; one that fails on the way keeps it for the next try', async () => {
  const w = await signedIn();
  await w.gateway.signIn(w.key, w.browser);
  w.clock.t += 3600_000;
  w.s.failToken = true;
  await assert.rejects(callMe(w.gateway, w.key));
  assert.equal(w.gateway.credentials.get(w.key).refreshToken, 'rt-1', 'a 500 keeps the sign-in');
  w.s.failToken = false;
  w.s.refuseRefresh = true;
  let changes = 0;
  w.gateway.on('changed', () => changes++);
  await assert.rejects(callMe(w.gateway, w.key));
  assert.equal(w.gateway.credentials.get(w.key), null, 'invalid_grant forgets it');
  // the server says so at once, with no tools left to fail, and Settings hears it (no restart by hand)
  await settled();
  assert.equal(row(w.gateway).status, 'needs_credentials');
  assert.equal(row(w.gateway).credential, 'none');
  assert.deepEqual(row(w.gateway).tools, []);
  assert.ok(changes > 0);
  w.gateway.close();
});

test('A4: a refresh that settles after a new sign-in or a sign-out never overwrites it', async () => {
  const dir = gatewayDir();
  const vault = new CredentialVault({ file: `${dir}/credentials.json`, safeStorage: fakeSafe(), now: () => 1 });
  const base = {
    type: 'oauth',
    authServer: 'https://as.example/',
    metadata: {
      authorization_endpoint: 'https://as.example/a',
      token_endpoint: 'https://as.example/t',
      response_types_supported: ['code'],
    },
    client: { client_id: 'c' },
    redirectUri: 'http://127.0.0.1:1/callback',
  };
  await vault.put('k', { ...base, accessToken: 'old', refreshToken: 'r-old', expiresAt: 0 });
  let answer!: (t: any) => void;
  const tokens = new OAuthTokens({ vault, now: () => 10, refresh: () => new Promise((r) => (answer = r)) });
  const p = tokens.access('k');
  await settled();
  await vault.put('k', { ...base, accessToken: 'new', refreshToken: 'r-new' });
  answer({ access_token: 'late', refresh_token: 'r-late', expires_in: 60 });
  assert.equal(await p, 'new', 'the request uses the newer sign-in');
  assert.equal(vault.get('k').accessToken, 'new');
  // signed out meanwhile: the late refresh writes nothing and the request needs a sign-in
  await vault.put('k', { ...base, accessToken: 'old', refreshToken: 'r-old', expiresAt: 0 });
  const q = tokens.access('k');
  await settled();
  await vault.delete('k');
  answer({ access_token: 'late', expires_in: 60 });
  await assert.rejects(q, (e: any) => e.code === 'needs_credentials');
  assert.equal(vault.get('k'), null);
});

test('the token goes only to the server’s own origin; the credential shape is checked (B1)', async () => {
  const sent: any[] = [];
  const vault = { get: () => ({ type: 'oauth', accessToken: 'tok' }), replaceIf: async () => true };
  const tokens = new OAuthTokens({
    vault,
    fetch: async (url: any, init: any) => (sent.push([String(url), new Headers(init?.headers).get('authorization')]), new Response('{}')),
  });
  const f = tokens.fetchFor('k', 'https://mcp.example');
  await f('https://mcp.example/mcp', { headers: { 'x-a': '1' } });
  await f('https://elsewhere.example/x');
  assert.deepEqual(sent, [
    ['https://mcp.example/mcp', 'Bearer tok'],
    ['https://elsewhere.example/x', null],
  ]);
  // shapes
  assert.equal(endpoint('http://example.com/t'), null);
  assert.equal(endpoint('http://localhost:3/t'), 'http://localhost:3/t');
  assert.equal(endpoint('nope'), null);
  assert.equal(
    metadataOf({ authorization_endpoint: 'https://a/', token_endpoint: 'http://evil/', response_types_supported: ['code'] }),
    null,
  );
  assert.equal(oauthCredentialOf({ type: 'oauth', accessToken: 'a' }), null);
  assert.equal(oauthCredentialOf({ type: 'bearer', token: 'a' }), null);
});

test('tokens: a stale credential another request refreshed answers with its token; no refresh token signs out; an answer without expiry keeps none', async () => {
  const dir = gatewayDir();
  const vault = new CredentialVault({ file: `${dir}/credentials.json`, safeStorage: fakeSafe(), now: () => 1 });
  const base = {
    type: 'oauth',
    authServer: 'https://as.example/',
    metadata: {
      authorization_endpoint: 'https://as.example/a',
      token_endpoint: 'https://as.example/t',
      response_types_supported: ['code'],
    },
    client: { client_id: 'c' },
    redirectUri: 'http://127.0.0.1:1/callback',
  };
  let refreshed = 0;
  const tokens = new OAuthTokens({
    vault,
    now: () => 10,
    refresh: async () => (refreshed++, { access_token: 'fresh', token_type: 'Bearer' }),
  });
  await vault.put('k', { ...base, accessToken: 'now', refreshToken: 'r', expiresAt: 5 });
  // a caller that saw an older credential: what is saved now, no refresh
  assert.equal(await tokens.refresh('k', { ...base, accessToken: 'older', refreshToken: 'r' }), 'now');
  assert.equal(refreshed, 0);
  // expired: refreshed; an answer with no expiry keeps none, and the refresh token stays
  assert.equal(await tokens.access('k'), 'fresh');
  assert.equal(vault.get('k').expiresAt, undefined);
  assert.equal(vault.get('k').refreshToken, 'r');
  // expired with no refresh token: forgotten, needs a sign-in
  await vault.put('k', { ...base, accessToken: 'x', expiresAt: 5 });
  await assert.rejects(tokens.access('k'), (e: any) => e.code === 'needs_credentials');
  assert.equal(vault.get('k'), null);
  await assert.rejects(tokens.access('k'), (e: any) => e.code === 'needs_credentials');
  // a 401 after another request refreshed meanwhile: that token, no refresh of our own
  await vault.put('k', { ...base, accessToken: 'a1', refreshToken: 'r' });
  const sent: string[] = [];
  const t2 = new OAuthTokens({
    vault,
    refresh: async () => assert.fail('no refresh: another request already did'),
    fetch: async (_url: any, init: any) => {
      const auth = new Headers(init.headers).get('authorization')!;
      sent.push(auth);
      if (auth === 'Bearer a1') {
        await vault.put('k', { ...base, accessToken: 'a2', refreshToken: 'r2' });
        return new Response('', { status: 401 });
      }
      return new Response('{}');
    },
  });
  await t2.fetchFor('k', 'https://mcp.example')('https://mcp.example/mcp', {});
  assert.deepEqual(sent, ['Bearer a1', 'Bearer a2']);
  // the vault refuses a replacement that isn't a credential
  await assert.rejects(
    vault.replaceIf('k', () => true, { type: 'oauth' }),
    /incomplete/,
  );
});

test('a sign-in that ends while the server starts (an expired token the server refuses to refresh) shows needs_credentials, not failed', async () => {
  const w = await signedIn();
  await w.gateway.signIn(w.key, w.browser);
  w.clock.t += 3600_000;
  w.s.refuseRefresh = true;
  await w.gateway.restart(w.key);
  await settled();
  assert.equal(row(w.gateway).status, 'needs_credentials');
  assert.equal(row(w.gateway).error, 'It needs to be connected first');
  w.gateway.close();
});

test('B5/A4: a refresh that never answers ends at its bound; a newer sign-in never inherits an older one’s refused refresh', async () => {
  const dir = gatewayDir();
  const vault = new CredentialVault({ file: `${dir}/credentials.json`, safeStorage: fakeSafe(), now: () => 1 });
  const base = {
    type: 'oauth',
    authServer: 'https://as.example/',
    metadata: {
      authorization_endpoint: 'https://as.example/a',
      token_endpoint: 'https://as.example/t',
      response_types_supported: ['code'],
    },
    client: { client_id: 'c' },
    redirectUri: 'http://127.0.0.1:1/callback',
  };
  await vault.put('k', { ...base, accessToken: 'a', refreshToken: 'r', expiresAt: 0 });
  // the real refreshAuthorization over a token endpoint that never answers (but honors the abort)
  const hang = new OAuthTokens({
    vault,
    now: () => 10,
    refreshMs: 50,
    fetch: (_u: any, init: any) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
  });
  const started = Date.now();
  await assert.rejects(hang.access('k'));
  assert.ok(Date.now() - started < 3000);
  assert.equal(hang.refreshing.size, 0, 'nothing left in flight');
  assert.equal(vault.get('k').accessToken, 'a', 'a refresh that timed out keeps the sign-in');
  // A's refresh is refused while B was saved and a request for B refreshes: B's caller gets B's own refresh
  let refuseA!: (e: any) => void;
  let signedOut = 0;
  const two = new OAuthTokens({
    vault,
    now: () => 10,
    onSignedOut: () => signedOut++,
    refresh: (_s: any, o: any) =>
      o.refreshToken === 'r'
        ? new Promise((_r, reject) => (refuseA = reject))
        : Promise.resolve({ access_token: 'b2', token_type: 'Bearer', expires_in: 3600 }),
  });
  const forA = two.access('k');
  await settled();
  await vault.put('k', { ...base, accessToken: 'b', refreshToken: 'rb', expiresAt: 0 });
  const forB = two.refresh('k', vault.get('k'));
  refuseA(Object.assign(new Error('refused'), { errorCode: 'invalid_grant' }));
  await assert.rejects(forA, (e: any) => e.code === 'needs_credentials');
  assert.equal(await forB, 'b2');
  assert.equal(vault.get('k').accessToken, 'b2', 'B stands');
  assert.equal(signedOut, 0, 'the refused A was no longer saved: nothing signed out');
});

test('a short-lived token refreshes at half its life, not on every request; a lifetime of 0 or less is no expiry', async () => {
  const w = await signedIn({ expiresIn: 30 });
  await w.gateway.signIn(w.key, w.browser);
  const refreshes = () => w.s.requests.filter((r: any) => r.form?.grant_type === 'refresh_token').length;
  for (let i = 0; i < 3; i++) await callMe(w.gateway, w.key);
  assert.equal(refreshes(), 0);
  w.clock.t += 16_000;
  assert.equal(await callMe(w.gateway, w.key), 'as at-2');
  assert.equal(refreshes(), 1);
  w.gateway.close();
  const z = await signedIn({ expiresIn: 0 });
  await z.gateway.signIn(z.key, z.browser);
  assert.equal(z.gateway.credentials.get(z.key).expiresAt, undefined);
  z.gateway.close();
});

test('a sign-out by another MoPilot is noticed at the next request: the server shows needs_credentials and offers nothing', async () => {
  const w = await signedIn();
  await w.gateway.signIn(w.key, w.browser);
  // another MoPilot's vault on the same file forgets the sign-in
  const other = new CredentialVault({
    file: `${w.gateway.credentials.store.file}`,
    safeStorage: w.gateway.credentials.store.safe,
    now: () => 1,
  });
  await other.delete(w.key);
  await assert.rejects(callMe(w.gateway, w.key));
  await settled();
  assert.equal(row(w.gateway).status, 'needs_credentials');
  assert.deepEqual(row(w.gateway).tools, []);
  w.gateway.close();
});

test('calls in flight when a sign-in ends come back stale, not as a closed connection', async () => {
  const w = await signedIn();
  await w.gateway.signIn(w.key, w.browser);
  w.clock.t += 3600_000;
  w.s.refuseRefresh = true;
  const r = w.gateway.upstreams.get(w.key);
  const { StaleError } = require('../electron/gateway/upstream.cjs');
  const calls = [0, 1, 2].map(() => w.gateway.upstreams.call(w.key, r.epoch, 'me', {}, { timeout: 5000, maxTotalTimeout: 5000 }));
  const outcomes = await Promise.allSettled(calls);
  for (const o of outcomes)
    assert.ok(
      o.status === 'rejected' && (o.reason instanceof StaleError || o.reason?.code === 'needs_credentials'),
      String(o.status === 'rejected' && o.reason?.message),
    );
  await settled();
  assert.equal(row(w.gateway).status, 'needs_credentials');
  w.gateway.close();
});
