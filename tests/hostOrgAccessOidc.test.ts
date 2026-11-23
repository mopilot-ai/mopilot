// The OIDC client for organization access (#3361 Tier 2): discovery, PKCE sign-in over a real loopback redirect, refresh, revoke and how an IdP's failures are told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createRequire } from 'node:module';
import { useFakeClock } from './support/ports/clock.ts';

const require = createRequire(import.meta.url);
const { createOidcClient, claimsOf } = require('../electron/host/orgAccess/oidc.cjs');

const ISSUER = 'https://idp.example.test';
const CFG = { issuer: ISSUER, clientId: 'client-1' };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: unknown) => `h.${b64(claims)}.s`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const DOC = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  revocation_endpoint: `${ISSUER}/revoke`,
};

type Call = { url: string; form: Record<string, string> };
/** A fake IdP: discovery answers `doc`, the token endpoint answers `token(form)`. */
function idp(
  opts: { doc?: unknown; token?: (form: Record<string, string>) => Response | Promise<Response>; revoke?: () => Response } = {},
) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const form = init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    calls.push({ url, form });
    if (url.endsWith('/.well-known/openid-configuration')) return json(opts.doc ?? DOC);
    if (url.endsWith('/revoke')) return opts.revoke ? opts.revoke() : json({});
    return opts.token ? opts.token(form) : json({});
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const get = (url: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) =>
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject),
  );

/** An openExternal that parses the auth URL, then lets `visit` act as the browser. */
function browser(visit: (auth: URL, redirectUri: string) => Promise<void>) {
  const seen: URL[] = [];
  return {
    seen,
    openExternal: async (href: string) => {
      const auth = new URL(href);
      seen.push(auth);
      await visit(auth, auth.searchParams.get('redirect_uri') as string);
    },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

test('discovery is read once per issuer and must name that issuer with usable endpoints', async () => {
  const f = idp();
  const c = createOidcClient({ fetch: f.fetch, openExternal: () => undefined });
  assert.equal((await c.discover(ISSUER)).token_endpoint, `${ISSUER}/token`);
  await c.discover(ISSUER);
  assert.equal(f.calls.length, 1);
  for (const doc of [
    { ...DOC, issuer: 'https://other.example.test' },
    { ...DOC, authorization_endpoint: 'ftp://x' },
    { ...DOC, token_endpoint: undefined },
  ]) {
    const bad = createOidcClient({ fetch: idp({ doc }).fetch, openExternal: () => undefined });
    await assert.rejects(bad.discover(ISSUER), { code: 'invalid' });
  }
});

test('a full PKCE sign-in: S256 challenge, loopback redirect, wrong state and other paths refused, then the code is exchanged with the matching verifier', async () => {
  let challenge = '';
  let redirect = '';
  let nonce = '';
  const f = idp({
    token: (form) => {
      assert.equal(crypto.createHash('sha256').update(form.code_verifier).digest('base64url'), challenge);
      assert.equal(form.redirect_uri, redirect);
      return json({
        access_token: 'access-token-aaaaaaaaaaaa',
        refresh_token: 'refresh-1',
        expires_in: 600,
        id_token: jwt({ iss: `${ISSUER}/`, nonce, sub: 'user-1', email: 'a@example.test' }),
      });
    },
  });
  const b = browser(async (auth, redirectUri) => {
    redirect = redirectUri;
    challenge = auth.searchParams.get('code_challenge') as string;
    nonce = auth.searchParams.get('nonce') as string;
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(auth.searchParams.get('response_type'), 'code');
    assert.equal(auth.searchParams.get('scope'), 'openid email');
    const state = auth.searchParams.get('state');
    assert.equal((await get(`${redirectUri.replace('/callback', '/other')}`)).status, 404);
    assert.equal((await get(`${redirectUri}?state=wrong&code=x`)).status, 400);
    const ok = await get(`${redirectUri}?state=${state}&code=the-code`);
    assert.equal(ok.status, 200);
    assert.match(ok.body, /Signed in/);
  });
  const c = createOidcClient({ fetch: f.fetch, openExternal: b.openExternal });
  const t = await c.signIn({ ...CFG, scopes: 'openid email' }, { now: () => 1000 });
  assert.deepEqual(t, {
    accessToken: 'access-token-aaaaaaaaaaaa',
    expiresAt: 1000 + 600_000,
    refreshToken: 'refresh-1',
    subject: 'user-1',
    who: 'a@example.test',
    idToken: t.idToken,
  });
  assert.equal(typeof t.idToken, 'string');
});

test('an access_denied redirect with the right state ends the sign-in as signin_required', async () => {
  const b = browser(async (auth, redirectUri) => {
    const state = auth.searchParams.get('state');
    assert.equal((await get(`${redirectUri}?state=${state}&error=access_denied`)).status, 400);
  });
  const c = createOidcClient({ fetch: idp().fetch, openExternal: b.openExternal });
  await assert.rejects(c.signIn(CFG), { code: 'signin_required' });
});

test('a sign-in nobody finishes times out, and the abort signal cancels it', async (t) => {
  const clock = useFakeClock(t);
  const c = createOidcClient({ fetch: idp().fetch, openExternal: () => undefined, signinMs: 50 });
  const timedOut = c.signIn(CFG);
  const caught = assert.rejects(timedOut, { code: 'timeout' });
  await tick();
  await tick();
  clock.advance(51);
  await caught;

  const ctrl = new AbortController();
  const cancelled = c.signIn(CFG, { signal: ctrl.signal });
  const caught2 = assert.rejects(cancelled, { code: 'cancelled' });
  await tick();
  await tick();
  ctrl.abort();
  await caught2;
});

/** Runs a sign-in whose token endpoint answers `tokenBody`, with `claims` in an id token that echoes the nonce unless overridden. */
async function signInWith(tokenBody: (nonce: string) => Record<string, unknown>) {
  let nonce = '';
  const f = idp({ token: () => json(tokenBody(nonce)) });
  const b = browser(async (auth, redirectUri) => {
    nonce = auth.searchParams.get('nonce') as string;
    await get(`${redirectUri}?state=${auth.searchParams.get('state')}&code=c`);
  });
  const c = createOidcClient({ fetch: f.fetch, openExternal: b.openExternal });
  return c.signIn(CFG, { now: () => 5 });
}
const AT = 'access-token-aaaaaaaaaaaa';

test('an id token for another request or issuer is refused as invalid', async () => {
  await assert.rejects(
    signInWith(() => ({ access_token: AT, id_token: jwt({ iss: ISSUER, nonce: 'other', sub: 's' }) })),
    { code: 'invalid' },
  );
  await assert.rejects(
    signInWith((nonce) => ({ access_token: AT, id_token: jwt({ iss: 'https://evil.example.test', nonce, sub: 's' }) })),
    { code: 'invalid' },
  );
});

test('no subject anywhere is invalid; the subject may come from the access token; who falls back to preferred_username then null', async () => {
  await assert.rejects(
    signInWith((nonce) => ({ access_token: AT, id_token: jwt({ iss: ISSUER, nonce }) })),
    { code: 'invalid' },
  );
  await assert.rejects(
    signInWith(() => ({ access_token: AT })),
    { code: 'invalid' },
  );
  const viaAccess = await signInWith(() => ({ access_token: jwt({ sub: 'from-access', exp: 100 }) }));
  assert.deepEqual([viaAccess.subject, viaAccess.who, viaAccess.refreshToken, viaAccess.expiresAt], ['from-access', null, null, 100_000]);
  const viaName = await signInWith((nonce) => ({
    access_token: AT,
    refresh_token: 7,
    expires_in: 'x',
    id_token: jwt({ iss: ISSUER, nonce, sub: 's', preferred_username: 'pat' }),
  }));
  assert.deepEqual([viaName.who, viaName.refreshToken, viaName.expiresAt], ['pat', null, 5 + 300_000]);
  await assert.rejects(
    signInWith(() => ({ expires_in: 5 })),
    { code: 'unreachable' },
  );
});

test('a listener that cannot start fails the sign-in; defaults (global fetch, real random, Date) are used when none are given', async () => {
  class Broken extends EventEmitter {
    listen() {
      queueMicrotask(() => this.emit('error', new Error('EADDRINUSE')));
    }
    close() {}
  }
  const c = createOidcClient({ fetch: idp().fetch, openExternal: () => undefined, createServer: (() => new Broken()) as any });
  await assert.rejects(c.signIn(CFG), /EADDRINUSE/);
  assert.equal(typeof createOidcClient({ openExternal: () => undefined }).discover, 'function');
});

test('refresh: expires_in, else the JWT exp, else five minutes; a new refresh token is passed on', async () => {
  const seq = [{ access_token: AT, expires_in: 60, refresh_token: 'r2' }, { access_token: jwt({ exp: 2000 }) }, { access_token: AT }];
  const f = idp({ token: () => json(seq.shift()) });
  const c = createOidcClient({ fetch: f.fetch, openExternal: () => undefined });
  assert.deepEqual(await c.refresh(CFG, 'r1', 10), { accessToken: AT, expiresAt: 10 + 60_000, refreshToken: 'r2', idToken: undefined });
  assert.equal((await c.refresh(CFG, 'r1', 10)).expiresAt, 2_000_000);
  assert.equal((await c.refresh(CFG, 'r1', 10)).expiresAt, 10 + 300_000);
  assert.deepEqual(f.calls.at(-1)?.form, { grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'client-1' });
});

test('an IdP failure is told by its code: signin_required, unreachable or invalid', async () => {
  const run = (res: () => Response | Promise<Response>) =>
    createOidcClient({ fetch: idp({ token: res }).fetch, openExternal: () => undefined }).refresh(CFG, 'r', 0);
  await assert.rejects(
    run(() => json({ error: 'invalid_grant' }, 400)),
    { code: 'signin_required' },
  );
  await assert.rejects(
    run(() => json({}, 401)),
    { code: 'signin_required' },
  );
  await assert.rejects(
    run(() => json({}, 503)),
    { code: 'unreachable' },
  );
  await assert.rejects(
    run(() => json({ error: 'invalid_client' }, 400)),
    { code: 'invalid', message: /invalid_client/ },
  );
  await assert.rejects(
    run(() => json({}, 400)),
    { code: 'invalid', message: /400/ },
  );
  await assert.rejects(
    run(() => new Response('<html>', { status: 200 })),
    { code: 'unreachable' },
  );
  await assert.rejects(
    run(() => new Response('null')),
    { code: 'unreachable' },
  );
  await assert.rejects(
    run(() => new Response('x'.repeat((1 << 20) + 1))),
    { code: 'unreachable', message: /too large/ },
  );
  await assert.rejects(
    run(() => Promise.reject(new Error('offline'))),
    { code: 'unreachable' },
  );
  await assert.rejects(
    run(() => ({ ok: true, text: () => Promise.reject(new Error('cut')) }) as any),
    { code: 'unreachable' },
  );
});

test('revoke is true when the IdP offers it and takes it; false without an endpoint, on failure or when unreachable', async () => {
  const f = idp({ revoke: () => new Response('') });
  assert.equal(await createOidcClient({ fetch: f.fetch, openExternal: () => undefined }).revoke(CFG, 'r1'), true);
  assert.deepEqual(f.calls.at(-1)?.form, { token: 'r1', token_type_hint: 'refresh_token', client_id: 'client-1' });
  const none = idp({ doc: { ...DOC, revocation_endpoint: undefined } });
  assert.equal(await createOidcClient({ fetch: none.fetch, openExternal: () => undefined }).revoke(CFG, 'r1'), false);
  const failing = idp({ revoke: () => json({}, 500) });
  assert.equal(await createOidcClient({ fetch: failing.fetch, openExternal: () => undefined }).revoke(CFG, 'r1'), false);
  const down = (() => Promise.reject(new Error('x'))) as unknown as typeof fetch;
  assert.equal(await createOidcClient({ fetch: down, openExternal: () => undefined }).revoke(CFG, 'r1'), false);
});

test('claimsOf reads a JWT payload and nothing else', () => {
  assert.deepEqual(claimsOf(jwt({ a: 1 })), { a: 1 });
  for (const bad of [null, 5, 'nodots', 'a.@@.c', `a.${b64([1])}.c`, `a.${b64('x')}.c`, `a.${Buffer.from('null').toString('base64url')}.c`])
    assert.equal(claimsOf(bad), null);
});

test('a request with no url reads as the root and is not the callback', async () => {
  const server: any = new EventEmitter();
  server.listen = (_port: number, _host: string, cb: () => void) => cb();
  server.address = () => ({ port: 1 });
  server.close = () => undefined;
  const ctrl = new AbortController();
  const ends: number[] = [];
  const res = { writeHead: (code: number) => ({ end: () => ends.push(code) }) };
  const c = createOidcClient({
    fetch: idp().fetch,
    createServer: (() => server) as any,
    openExternal: () => {
      server.emit('request', {}, res);
      ctrl.abort();
    },
  });
  await assert.rejects(c.signIn(CFG, { signal: ctrl.signal }), { code: 'cancelled' });
  assert.deepEqual(ends, [404]);
});
