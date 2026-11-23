// OAuth 2.1 sign-in for managed servers (electron/gateway/oauthSignIn.cjs, oauthCredential.cjs, service.cjs signIn, #2999 C2b) against a real authorization server and protected MCP server on 127.0.0.1: discovery (RFC 9728 → RFC 8414, and a server with no protected-resource metadata), dynamic client registration (RFC 7591), PKCE S256 and the resource indicator (RFC 8707) on the authorization and token requests; a sign-out, a newer sign-in, a removal or quitting during the browser wait saves nothing (A4); each failing step says which step, never the server's words (B1/B2); the credential's shape is checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeSafe } from './support/momo-fixtures.ts';
import { gatewayDir, tick } from './support/gatewayWorld.ts';
import { oauthWorld } from './support/gatewayOAuthServer.ts';

const require = createRequire(import.meta.url);
const { Gateway } = require('../electron/gateway/service.cjs');
const { signIn, SignInError } = require('../electron/gateway/oauthSignIn.cjs');

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

test('sign-in: discovery, registration, PKCE and the resource indicator; the server then runs with the token', async () => {
  const w = await signedIn();
  assert.equal(row(w.gateway).status, 'needs_credentials');
  await w.gateway.signIn(w.key, w.browser);
  assert.equal(row(w.gateway).status, 'ready', row(w.gateway).error);
  assert.equal(row(w.gateway).credential, 'saved');
  // RFC 9728 first, then RFC 8414 at the server it names
  const paths = w.s.requests.map((r: any) => `${r.at} ${r.method} ${r.path.split('?')[0]}`);
  assert.ok(
    paths.indexOf('mcp GET /.well-known/oauth-protected-resource/mcp') < paths.indexOf('as GET /.well-known/oauth-authorization-server'),
  );
  // registered for this sign-in's loopback redirect, public client
  const [client] = [...w.s.clients.values()];
  assert.match(client.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(client.token_endpoint_auth_method, 'none');
  assert.equal(client.client_name, 'MoPilot');
  // the authorize request carried PKCE S256, state, scope and the resource; the token request the resource and verifier
  assert.equal(w.s.lastAuthorize.code_challenge_method, 'S256');
  assert.equal(w.s.lastAuthorize.resource, w.mcpUrl);
  assert.equal(w.s.lastAuthorize.scope, 'mcp');
  const token = w.s.requests.find((r: any) => r.form?.grant_type === 'authorization_code').form;
  assert.equal(token.resource, w.mcpUrl);
  assert.ok(token.code_verifier.length >= 43);
  assert.equal(await callMe(w.gateway, w.key), 'as at-1');
  // the vault keeps what a refresh needs, and the window never sees it
  const c = w.gateway.credentials.get(w.key);
  assert.equal(c.type, 'oauth');
  assert.equal(c.refreshToken, 'rt-1');
  assert.equal(c.expiresAt, w.clock.t + 3600_000);
  assert.doesNotMatch(JSON.stringify(w.gateway.view()), /at-1|rt-1|client-1/);
  w.gateway.close();
});

test('A4: a sign-out during the browser wait cancels the sign-in; nothing is saved and no token is asked for', async () => {
  const w = await signedIn();
  let opened!: () => void;
  const atBrowser = new Promise<void>((r) => (opened = r));
  const p = w.gateway.signIn(w.key, async () => opened());
  await atBrowser;
  assert.equal(row(w.gateway).signingIn, true);
  const cancelled = assert.rejects(p, (e: any) => e.code === 'closed');
  await w.gateway.disconnect(w.key);
  await cancelled;
  assert.equal(w.gateway.credentials.get(w.key), null);
  assert.equal(row(w.gateway).signingIn, false);
  assert.ok(!w.s.requests.some((r: any) => r.form?.grant_type === 'authorization_code'));
  // a second sign-in replaces the first, which never saves
  let first!: () => void;
  const firstAt = new Promise<void>((r) => (first = r));
  const one = w.gateway.signIn(w.key, async () => first());
  await firstAt;
  const two = w.gateway.signIn(w.key, w.browser);
  await assert.rejects(one, (e: any) => e.code === 'closed');
  await two;
  assert.equal(row(w.gateway).status, 'ready');
  // and removing the server cancels one in flight
  let third!: () => void;
  const thirdAt = new Promise<void>((r) => (third = r));
  const three = w.gateway.signIn(w.key, async () => third());
  await thirdAt;
  const removed = assert.rejects(three);
  await w.gateway.remove(w.key);
  await removed;
  assert.deepEqual(w.gateway.view().servers, []);
  w.gateway.close();
});

test('B1/B2: each failing step says which step, never the server’s words', async () => {
  const open = async () => {};
  // nothing to discover
  await assert.rejects(signIn({ url: 'http://127.0.0.1:9/mcp', open }), (e: any) => e instanceof SignInError && e.code === 'discovery');
  // no dynamic registration
  const noReg = await oauthWorld({ registration: false });
  await assert.rejects(signIn({ url: noReg.mcpUrl, open: noReg.browser }), (e: any) => e.code === 'registration');
  // the user (or the server) says no
  const deny = await oauthWorld();
  deny.s.deny = true;
  await assert.rejects(signIn({ url: deny.mcpUrl, open: deny.browser }), (e: any) => e.code === 'denied');
  // the token endpoint fails
  const bad = await oauthWorld();
  bad.s.failToken = true;
  await assert.rejects(signIn({ url: bad.mcpUrl, open: bad.browser }), (e: any) => e.code === 'token' && !/server_error/.test(e.message));
  // the browser can't be opened
  const w = await oauthWorld();
  await assert.rejects(
    signIn({
      url: w.mcpUrl,
      open: async () => {
        throw new Error('no browser');
      },
    }),
    (e: any) => e.code === 'open',
  );
  // a server with no protected-resource metadata: its origin is the authorization server, its URL the resource
  const legacy = await oauthWorld({ prm: false });
  await assert.rejects(signIn({ url: legacy.mcpUrl, open: legacy.browser }), (e: any) => e.code === 'discovery');
  // the timeout of the listener and a cancel before anything is sent
  const ac = new AbortController();
  ac.abort();
  const w2 = await oauthWorld();
  await assert.rejects(signIn({ url: w2.mcpUrl, open: w2.browser, signal: ac.signal }), (e: any) => e.code === 'closed');
  assert.equal(w2.s.clients.size, 0, 'nothing registered once cancelled');
});

test('a server with no protected-resource metadata: its origin names the authorization server, its own URL is the resource', async () => {
  const w = await oauthWorld({ legacy: true });
  w.s.bare = true;
  const c = await signIn({ url: w.mcpUrl, open: w.browser, now: () => 5 });
  assert.equal(w.s.lastAuthorize.resource, w.mcpUrl);
  assert.equal(w.s.lastAuthorize.scope, undefined, 'no scopes published: none asked for');
  // a token answer with no expiry, scope or refresh token is kept as it is
  assert.equal(c.accessToken, 'at-1');
  assert.equal(c.expiresAt, undefined);
  assert.equal(c.scope, undefined);
  assert.equal(c.refreshToken, undefined);
  // a registration whose client id isn't usable, a token that isn't, and a client secret kept with its expiry
  const bad = await oauthWorld();
  bad.s.badClient = true;
  await assert.rejects(signIn({ url: bad.mcpUrl, open: bad.browser }), (e: any) => e.code === 'registration');
  const badTok = await oauthWorld();
  badTok.s.badToken = true;
  await assert.rejects(signIn({ url: badTok.mcpUrl, open: badTok.browser }), (e: any) => e.code === 'token');
  const secret = await oauthWorld();
  secret.s.clientSecret = true;
  const withSecret = await signIn({ url: secret.mcpUrl, open: secret.browser });
  assert.deepEqual([withSecret.client.client_secret, withSecret.client.client_secret_expires_at], ['shh', 0]);
});

test('sign-in refuses a server that isn’t managed or doesn’t use OAuth; one whose server left, or that was replaced, saves nothing; quitting cancels it', async () => {
  const w = await signedIn();
  await assert.rejects(w.gateway.signIn('["http","nope"]', w.browser), /not managed/);
  const other = await w.gateway.add({ name: 'b', launch: { type: 'http', url: 'https://b.example/', headers: {} }, auth: 'bearer' });
  await assert.rejects(w.gateway.signIn(other.key, w.browser), /doesn’t sign in with OAuth/);
  // the server's entry went (another MoPilot removed it) while the browser was open
  await assert.rejects(
    w.gateway.signIn(w.key, async (url: string) => {
      await w.gateway.servers.remove(w.key);
      await w.browser(url);
    }),
    (e: any) => e.code === 'closed',
  );
  assert.equal(w.gateway.credentials.get(w.key), null);
  // replaced without a cancel reaching it (the sign-in's own entry moved on)
  const again = await w.gateway.add({ name: 'p', launch: { type: 'http', url: w.mcpUrl, headers: {} }, auth: 'oauth' });
  await assert.rejects(
    w.gateway.signIn(again.key, async (url: string) => {
      w.gateway.signIns.set(again.key, new AbortController());
      await w.browser(url);
    }),
    (e: any) => e.code === 'closed',
  );
  assert.equal(w.gateway.credentials.get(again.key), null);
  // quitting while one waits on the browser
  let at!: () => void;
  const waiting = new Promise<void>((r) => (at = r));
  const pending = w.gateway.signIn(again.key, async () => at());
  const ended = assert.rejects(pending, (e: any) => e.code === 'closed');
  await waiting;
  w.gateway.close();
  await ended;
  // requestAuth with no token source for an OAuth server: it needs signing in
  const { requestAuth } = require('../electron/gateway/auth.cjs');
  assert.throws(
    () =>
      requestAuth(
        { key: 'k', auth: 'oauth', launch: { type: 'http', url: 'https://x/', headers: {} } },
        { type: 'oauth', accessToken: 't' },
        null,
      ),
    (e: any) => e.code === 'needs_credentials',
  );
});

test('B1: a callback error is shown by its RFC 6749 code only; the authorization server’s own words never reach the user', async () => {
  for (const [sent, shown] of [
    ['access_denied', 'The sign-in was not allowed (access_denied)'],
    ['Your account is locked, call +1-555-0100 at evil.example now', 'The sign-in was not allowed (error)'],
  ]) {
    const w = await oauthWorld();
    w.s.deny = sent;
    await assert.rejects(signIn({ url: w.mcpUrl, open: w.browser }), (e: any) => e.code === 'denied' && e.message === shown);
  }
});
