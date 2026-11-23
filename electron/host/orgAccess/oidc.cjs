// The OpenID Connect client the app signs in to an organization's IdP with (#3361 Tier 2): discovery, authorization code with PKCE (S256) in the system browser and a one-time loopback redirect on 127.0.0.1, refresh and revocation. Tokens come back to the caller and are never logged; an IdP's error is told by its code, never with what was sent.
const crypto = require('node:crypto');
const http = require('node:http');
const { baseUrlOf } = require('../../../shared/host/orgAccess.mjs');
const { clock } = require('../../platform/ports/clock.cjs');

/** How long the person has to finish signing in in the browser. */
const SIGNIN_MS = 5 * 60_000;
/** How long one call to the IdP may take. */
const CALL_MS = 20_000;
/** The most an IdP's answer may hold. */
const MAX_BODY = 1 << 20;

/** A refusal the window shows as it is: `signin_required` (sign in again), `unreachable` (try again), `invalid` (the settings are wrong). @param {string} message @param {string} code */
const refusal = (message, code) => Object.assign(new Error(message), { code });
const b64url = (/** @type {Buffer} */ b) => b.toString('base64url');

/**
 * The claims of a JWT's payload, unchecked: the id token came straight from the token endpoint over TLS, so its claims are read, not its signature.
 * @param {unknown} jwt @returns {Record<string, any> | null}
 */
function claimsOf(jwt) {
  if (typeof jwt !== 'string') return null;
  const part = jwt.split('.')[1];
  try {
    const c = JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8'));
    return c && typeof c === 'object' && !Array.isArray(c) ? c : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} o
 * @param {typeof fetch} [o.fetch]
 * @param {(url: string) => unknown} o.openExternal opens the IdP's sign-in page in the system browser
 * @param {typeof http.createServer} [o.createServer] the loopback listener (tests bring their own)
 * @param {(n: number) => Buffer} [o.randomBytes]
 * @param {number} [o.signinMs]
 */
function createOidcClient({
  fetch: fetchFn = globalThis.fetch,
  openExternal,
  createServer = http.createServer,
  randomBytes = crypto.randomBytes,
  signinMs = SIGNIN_MS,
}) {
  /** @type {Map<string, Record<string, any>>} each issuer's discovery document */
  const discovered = new Map();

  /** One call to the IdP: its JSON answer, or a refusal by what went wrong. @param {string} url @param {RequestInit} [init] */
  async function call(url, init) {
    const ctrl = new AbortController();
    const timer = clock.setTimeout(() => ctrl.abort(), CALL_MS);
    /** @type {Response} */
    let res;
    let text = '';
    try {
      res = await fetchFn(url, { ...init, signal: ctrl.signal, redirect: 'error' });
      text = await res.text();
    } catch {
      throw refusal("Couldn't reach your organization's sign-in. Try again.", 'unreachable');
    } finally {
      clock.clearTimeout(timer);
    }
    if (text.length > MAX_BODY) throw refusal("Your organization's sign-in sent an answer too large to read.", 'unreachable');
    /** @type {any} */
    let body = null;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = null;
    }
    if (!body || typeof body !== 'object') throw refusal("Your organization's sign-in sent an answer that isn't JSON.", 'unreachable');
    if (!res.ok) {
      // an expired or revoked grant, a disabled user, an ended session: one more sign-in fixes it
      if (body.error === 'invalid_grant' || res.status === 401) throw refusal('Sign in to your organization again.', 'signin_required');
      if (res.status >= 500) throw refusal("Your organization's sign-in isn't answering. Try again.", 'unreachable');
      throw refusal(`Your organization's sign-in refused it (${String(body.error ?? res.status).slice(0, 60)}).`, 'invalid');
    }
    return body;
  }

  /** The issuer's discovery document, read once; it must name this issuer. @param {string} issuer */
  async function discover(issuer) {
    const have = discovered.get(issuer);
    if (have) return have;
    const doc = await call(`${issuer}/.well-known/openid-configuration`);
    if (baseUrlOf(doc.issuer) !== issuer || !baseUrlOf(doc.authorization_endpoint) || !baseUrlOf(doc.token_endpoint))
      throw refusal("That issuer's settings don't match its address.", 'invalid');
    discovered.set(issuer, doc);
    return doc;
  }

  /** @param {string} tokenEndpoint @param {Record<string, string>} form */
  const tokenCall = (tokenEndpoint, form) =>
    call(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });

  /** @param {any} t @param {number} now */
  const tokensOf = (t, now) => {
    if (typeof t.access_token !== 'string' || !t.access_token) throw refusal("Your organization's sign-in sent no token.", 'unreachable');
    const exp = claimsOf(t.access_token)?.exp;
    const expiresAt = Number.isFinite(t.expires_in) ? now + t.expires_in * 1000 : Number.isFinite(exp) ? exp * 1000 : now + 5 * 60_000;
    return {
      accessToken: t.access_token,
      expiresAt,
      refreshToken: typeof t.refresh_token === 'string' ? t.refresh_token : null,
      idToken: t.id_token,
    };
  };

  return {
    discover,
    /**
     * Signs the person in through the system browser: a loopback listener on 127.0.0.1 takes the one redirect, whose state must match.
     * @param {{ issuer: string, clientId: string, scopes?: string }} cfg @param {{ now?: () => number, signal?: AbortSignal }} [o]
     * @returns {Promise<{ accessToken: string, expiresAt: number, refreshToken: string | null, subject: string, who: string | null }>}
     */
    async signIn(cfg, { now = Date.now, signal } = {}) {
      const doc = await discover(cfg.issuer);
      const verifier = b64url(randomBytes(32));
      const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
      const state = b64url(randomBytes(16));
      const nonce = b64url(randomBytes(16));
      const server = createServer();
      // the redirect, a timeout or a cancel settle it once, as a value: one that comes before it is awaited is never an unhandled rejection
      const waiter = /** @type {{ resolve: (v: { code: string, redirectUri: string } | { error: Error }) => void }} */ ({});
      const got = new Promise((resolve) => Object.assign(waiter, { resolve }));
      const done = (/** @type {{ code: string, redirectUri: string }} */ v) => waiter.resolve(v);
      const fail = (/** @type {Error} */ error) => waiter.resolve({ error });
      const timer = clock.setTimeout(() => fail(refusal('The sign-in took too long. Try again.', 'timeout')), signinMs);
      const abort = () => fail(refusal('The sign-in was cancelled.', 'cancelled'));
      signal?.addEventListener('abort', abort);
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => resolve(undefined));
        });
        const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
        const redirectUri = `http://127.0.0.1:${port}/callback`;
        server.on('request', (req, res) => {
          const url = new URL(req.url ?? '/', redirectUri);
          if (url.pathname !== '/callback') return void res.writeHead(404).end();
          const ok = url.searchParams.get('state') === state && !!url.searchParams.get('code');
          res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(
            ok
              ? 'Signed in. You can close this tab and go back to MoPilot.'
              : 'This sign-in did not work. Go back to MoPilot and try again.',
          );
          if (ok) done({ code: /** @type {string} */ (url.searchParams.get('code')), redirectUri });
          else if (url.searchParams.get('state') === state) fail(refusal('Your organization refused the sign-in.', 'signin_required'));
        });
        const auth = new URL(doc.authorization_endpoint);
        for (const [k, v] of Object.entries({
          response_type: 'code',
          client_id: cfg.clientId,
          redirect_uri: redirectUri,
          scope: cfg.scopes || 'openid profile email offline_access',
          state,
          nonce,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }))
          auth.searchParams.set(k, v);
        await openExternal(auth.href);
        const answer = /** @type {{ code: string } | { error: Error }} */ (await got);
        if ('error' in answer) throw answer.error;
        const { code } = answer;
        const t = await tokenCall(doc.token_endpoint, {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: cfg.clientId,
          code_verifier: verifier,
        });
        const claims = claimsOf(t.id_token);
        if (claims && (claims.nonce !== nonce || baseUrlOf(claims.iss) !== cfg.issuer))
          throw refusal("That sign-in wasn't for this request. Try again.", 'invalid');
        const tokens = tokensOf(t, now());
        const sub = claims?.sub ?? claimsOf(tokens.accessToken)?.sub;
        if (typeof sub !== 'string' || !sub) throw refusal("Your organization's sign-in didn't say who signed in.", 'invalid');
        return {
          ...tokens,
          subject: sub,
          who:
            typeof claims?.email === 'string'
              ? claims.email
              : typeof claims?.preferred_username === 'string'
                ? claims.preferred_username
                : null,
        };
      } finally {
        clock.clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        server.close();
      }
    },
    /** A fresh access token from the refresh token; the IdP may hand back a new refresh token. @param {{ issuer: string, clientId: string }} cfg @param {string} refreshToken @param {number} now */
    async refresh(cfg, refreshToken, now) {
      const doc = await discover(cfg.issuer);
      return tokensOf(
        await tokenCall(doc.token_endpoint, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: cfg.clientId }),
        now,
      );
    },
    /** Revokes the refresh token at the IdP, when it offers revocation; false when it does not or cannot be reached. @param {{ issuer: string, clientId: string }} cfg @param {string} refreshToken */
    async revoke(cfg, refreshToken) {
      try {
        const doc = await discover(cfg.issuer);
        if (!baseUrlOf(doc.revocation_endpoint)) return false;
        await tokenCall(doc.revocation_endpoint, { token: refreshToken, token_type_hint: 'refresh_token', client_id: cfg.clientId });
        return true;
      } catch {
        return false;
      }
    },
  };
}

module.exports = { createOidcClient, claimsOf };
