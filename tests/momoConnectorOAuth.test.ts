// MoMo's connector OAuth (electron/gateway/oauth.cjs, #2999 C0): PKCE S256, the authorization URL, the one-shot loopback server on 127.0.0.1 (state checked, wrong requests refused while the wait goes on, timeout, cancel, closed after the answer) and the token endpoint calls (code exchange, refresh, refusals that never echo what was sent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  pkce,
  newState,
  authorizeUrl,
  listenForCode,
  exchangeCode,
  refreshTokens,
  OAuthError,
  CALLBACK,
} = require('../electron/gateway/oauth.cjs');

test('PKCE: a 43-character verifier and its S256 challenge; states are fresh', () => {
  const p = pkce();
  assert.equal(p.method, 'S256');
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(p.challenge, crypto.createHash('sha256').update(p.verifier).digest('base64url'));
  assert.notEqual(pkce().verifier, p.verifier);
  assert.notEqual(newState(), newState());
});

test('the authorization URL carries the flow’s parameters, which extra parameters cannot override', () => {
  const u = new URL(
    authorizeUrl({
      authorizeUrl: 'https://auth.example/o?prompt=consent',
      clientId: 'cid',
      redirectUri: 'http://127.0.0.1:5555/callback',
      scopes: ['a', 'b'],
      state: 'st',
      challenge: 'ch',
      extra: { access_type: 'offline', state: 'evil', code_challenge_method: 'plain' },
    }),
  );
  const q = Object.fromEntries(u.searchParams);
  assert.deepEqual(q, {
    prompt: 'consent',
    access_type: 'offline',
    response_type: 'code',
    client_id: 'cid',
    redirect_uri: 'http://127.0.0.1:5555/callback',
    scope: 'a b',
    state: 'st',
    code_challenge: 'ch',
    code_challenge_method: 'S256',
  });
  assert.equal(
    new URL(
      authorizeUrl({ authorizeUrl: 'https://a.example/', clientId: 'c', redirectUri: 'r', scopes: [], state: 's', challenge: 'c' }),
    ).searchParams.get('scope'),
    '',
  );
});

const get = (url: string, method = 'GET') =>
  new Promise<number>((resolve, reject) => {
    const req = http.request(url, { method, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });

test('the loopback server binds 127.0.0.1 only, refuses wrong requests, answers the right state once and closes', async () => {
  const l = await listenForCode({ state: 'S1', timeoutMs: 10_000 });
  const u = new URL(l.redirectUri);
  assert.equal(u.hostname, '127.0.0.1');
  assert.equal(u.pathname, CALLBACK);
  assert.ok(Number(u.port) > 0);
  const base = l.redirectUri;
  assert.equal(await get(`http://127.0.0.1:${u.port}/other?state=S1&code=c`), 404);
  assert.equal(await get(`${base}?state=S1&code=c`, 'POST'), 404);
  assert.equal(await get(`${base}?state=WRONG&code=c`), 400);
  assert.equal(await get(`${base}?code=c`), 400);
  assert.equal(await get(`${base}?state=S1`), 400);
  assert.equal(await get(`${base}?state=S1&code=the-code`), 200);
  assert.equal(await l.code, 'the-code');
  // closed after the answer: nothing listens any more
  await assert.rejects(get(`${base}?state=S1&code=again`));
  l.close();
});

test('an error with the right state is a denial; timeout and cancel reject; a closed flow stays closed', async () => {
  const d = await listenForCode({ state: 'S2', timeoutMs: 10_000 });
  assert.equal(await get(`${d.redirectUri}?state=S2&error=access_denied`), 200);
  await assert.rejects(d.code, (e: any) => e instanceof OAuthError && e.code === 'denied' && /access_denied/.test(e.message));

  const t = await listenForCode({ state: 'S3', timeoutMs: 20 });
  await assert.rejects(t.code, (e: any) => e.code === 'timeout');

  const c = await listenForCode({ state: 'S4' });
  c.close();
  await assert.rejects(c.code, (e: any) => e.code === 'closed');
  c.close();
});

/** A fake http module: the test calls the request handler itself and drives the server's events. */
function fakeHttp() {
  const f: any = { handler: null, server: null };
  f.createServer = (h: any) => {
    f.handler = h;
    const s: any = new EventEmitter();
    s.closed = 0;
    s.close = () => void s.closed++;
    s.address = () => ({ port: 4242 });
    s.listen = (_p: number, host: string, cb: () => void) => {
      s.host = host;
      if (f.listenError) setImmediate(() => s.emit('error', f.listenError));
      else setImmediate(cb);
    };
    f.server = s;
    return s;
  };
  const res = () => {
    const r: any = { status: 0, body: '' };
    r.writeHead = (status: number) => ((r.status = status), r);
    r.end = (b = '') => ((r.body = b), r);
    return r;
  };
  f.call = (url: string, method = 'GET') => {
    const r = res();
    f.handler({ url, method }, r);
    return r;
  };
  return f;
}

test('a request after the answer (a kept-alive connection) is answered gone; a missing url reads as /; a listen error rejects', async () => {
  const f = fakeHttp();
  const l = await listenForCode({ state: 'S', http: f });
  assert.equal(f.server.host, '127.0.0.1');
  assert.equal(l.redirectUri, 'http://127.0.0.1:4242/callback');
  assert.equal(f.call(undefined as any).status, 404);
  const ok = f.call('/callback?state=S&code=k');
  assert.equal(ok.status, 200);
  assert.match(ok.body, /close this tab/);
  assert.equal(await l.code, 'k');
  assert.equal(f.call('/callback?state=S&code=k2').status, 410);
  assert.equal(f.server.closed, 1);

  const bad = fakeHttp();
  bad.listenError = new Error('EADDRNOTAVAIL');
  await assert.rejects(listenForCode({ state: 'S', http: bad }), /EADDRNOTAVAIL/);
});

function fakeFetch(answer: { ok?: boolean; json?: unknown; throws?: boolean; badJson?: boolean }) {
  const calls: any[] = [];
  const fn = async (url: string, init: any) => {
    calls.push({ url, init, form: Object.fromEntries(new URLSearchParams(init.body)) });
    if (answer.throws) throw new Error('network down with secret');
    return {
      ok: answer.ok ?? true,
      json: async () => {
        if (answer.badJson) throw new SyntaxError('not json');
        return answer.json;
      },
    };
  };
  return Object.assign(fn, { calls });
}

test('the code exchange posts the verifier and returns the token set with its expiry and scopes', async () => {
  const f = fakeFetch({ json: { access_token: 'A', refresh_token: 'R', expires_in: 3600, scope: 'x y' } });
  const t = await exchangeCode({
    tokenUrl: 'https://t.example/token',
    clientId: 'cid',
    code: 'C',
    verifier: 'V',
    redirectUri: 'http://127.0.0.1:1/callback',
    fetch: f,
    now: () => 1000,
  });
  assert.deepEqual(t, { accessToken: 'A', refreshToken: 'R', expiresAt: 1000 + 3_600_000, scopes: ['x', 'y'] });
  assert.equal(f.calls[0].url, 'https://t.example/token');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(f.calls[0].form, {
    grant_type: 'authorization_code',
    client_id: 'cid',
    code: 'C',
    code_verifier: 'V',
    redirect_uri: 'http://127.0.0.1:1/callback',
  });
  // no refresh token, no expiry, no scope
  const bare = await exchangeCode({
    tokenUrl: 'u',
    clientId: 'c',
    code: 'C',
    verifier: 'V',
    redirectUri: 'r',
    fetch: fakeFetch({ json: { access_token: 'A', refresh_token: '', expires_in: 0 } }),
  });
  assert.deepEqual(bare, { accessToken: 'A', scopes: [] });
});

test('a refresh keeps the old refresh token when none comes back; refusals say the provider’s code, never what was sent', async () => {
  const keep = await refreshTokens({
    tokenUrl: 'u',
    clientId: 'c',
    refreshToken: 'OLD',
    fetch: fakeFetch({ json: { access_token: 'A2' } }),
  });
  assert.equal(keep.refreshToken, 'OLD');
  const f = fakeFetch({ json: { access_token: 'A3', refresh_token: 'NEW' } });
  const turn = await refreshTokens({ tokenUrl: 'u', clientId: 'c', refreshToken: 'OLD', fetch: f });
  assert.equal(turn.refreshToken, 'NEW');
  assert.deepEqual(f.calls[0].form, { grant_type: 'refresh_token', client_id: 'c', refresh_token: 'OLD' });

  const refused = (answer: any) => refreshTokens({ tokenUrl: 'u', clientId: 'c', refreshToken: 'SECRET', fetch: fakeFetch(answer) });
  await assert.rejects(refused({ ok: false, json: { error: 'invalid_grant', error_description: 'token SECRET revoked' } }), (e: any) => {
    assert.equal(e.code, 'token');
    assert.match(e.message, /invalid_grant/);
    assert.doesNotMatch(e.message, /SECRET/);
    return true;
  });
  await assert.rejects(refused({ ok: true, json: { nope: 1 } }), (e: any) => e.code === 'token' && !/\(/.test(e.message));
  await assert.rejects(refused({ badJson: true }), (e: any) => e.code === 'token');
  await assert.rejects(refused({ throws: true }), (e: any) => e.code === 'token' && !/secret/.test(e.message));
});
