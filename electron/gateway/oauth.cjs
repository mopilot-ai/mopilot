// OAuth for connectors and MCP servers (#2999 C0, RFC 8252 + RFC 7636; MoMo's connectors so far): authorization code with PKCE (S256) through the system browser and a one-shot loopback server on 127.0.0.1 at a port the OS picks; the callback must carry the state this flow made, anything else is refused and the wait goes on until its timeout. The code is exchanged and tokens refreshed with the provider's token endpoint here in main; no broker in between.
const crypto = require('node:crypto');
const nodeHttp = require('node:http');
const { noteIgnored } = require('../ignored.cjs');

/** How long the browser has to come back with the code. */
const WAIT_MS = 5 * 60_000;
const CALLBACK = '/callback';
/** What the browser tab shows once it came back (it says nothing about the account). */
const DONE_PAGE = '<!doctype html><meta charset="utf-8"><title>MoPilot</title><p>You can close this tab and return to MoPilot.</p>';

const b64url = (/** @type {Buffer} */ b) => b.toString('base64url');

/**
 * The callback errors a sign-in may name (RFC 6749 §4.1.2.1): the provider's own words never reach the user, so any other
 * value is shown as `error`.
 */
const CALLBACK_ERRORS = new Set([
  'access_denied',
  'invalid_request',
  'unauthorized_client',
  'unsupported_response_type',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
]);

/** A PKCE pair: a 43-character verifier and its S256 challenge. */
function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), method: 'S256' };
}

/** A fresh, unguessable state value for one flow. */
const newState = () => b64url(crypto.randomBytes(24));

/**
 * The provider's authorization URL for this flow.
 * @param {{ authorizeUrl: string, clientId: string, redirectUri: string, scopes: string[], state: string, challenge: string,
 *   extra?: Record<string, string> }} o extra: provider parameters (e.g. access_type=offline)
 */
function authorizeUrl({ authorizeUrl: base, clientId, redirectUri, scopes, state, challenge, extra = {} }) {
  const url = new URL(base);
  const p = {
    ...extra,
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  };
  for (const [k, v] of Object.entries(p)) url.searchParams.set(k, v);
  return url.toString();
}

/** An OAuth step failed: `code` timeout, denied (the user or provider said no), closed, or token (the token endpoint). */
class OAuthError extends Error {
  /** @param {string} message @param {'timeout' | 'denied' | 'closed' | 'token'} code */
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * Listens once on 127.0.0.1 (an OS-picked port) for the browser's redirect. `code` resolves with the authorization code
 * of the first callback whose state is `state`; a callback with another state, another path or another method is
 * answered 400/404 and the wait goes on; one with the right state and an `error` rejects as denied. The server closes
 * after the answer, on timeout, or on close().
 * @param {{ state: string, timeoutMs?: number, http?: Pick<typeof nodeHttp, 'createServer'> }} o
 * @returns {Promise<{ redirectUri: string, code: Promise<string>, close: () => void }>}
 */
function listenForCode({ state, timeoutMs = WAIT_MS, http = nodeHttp }) {
  return new Promise((resolveStart, rejectStart) => {
    /** @type {(code: string) => void} */
    let done;
    /** @type {(e: Error) => void} */
    let fail;
    /** @type {Promise<string>} */
    const code = new Promise((res, rej) => {
      done = res;
      fail = rej;
    });
    // the caller may never await it (a cancelled flow): its rejection is still noted once, not left unhandled
    code.catch((e) => noteIgnored('end a connector sign-in wait', e));
    let settled = false;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (settled) return void res.writeHead(410).end();
      if (req.method !== 'GET' || url.pathname !== CALLBACK) return void res.writeHead(404).end();
      if (url.searchParams.get('state') !== state) return void res.writeHead(400).end();
      const error = url.searchParams.get('error');
      const got = url.searchParams.get('code');
      if (!error && !got) return void res.writeHead(400).end();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(DONE_PAGE);
      const shown = error && CALLBACK_ERRORS.has(error) ? error : 'error';
      finish(() => (error ? fail(new OAuthError(`The sign-in was not allowed (${shown})`, 'denied')) : done(/** @type {string} */ (got))));
    });
    const timer = setTimeout(() => finish(() => fail(new OAuthError('The sign-in took too long', 'timeout'))), timeoutMs);
    timer.unref();
    function finish(/** @type {() => void} */ then) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      then();
    }
    server.once('error', (e) => {
      clearTimeout(timer);
      rejectStart(e);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolveStart({
        redirectUri: `http://127.0.0.1:${addr.port}${CALLBACK}`,
        code,
        close: () => finish(() => fail(new OAuthError('The sign-in was cancelled', 'closed'))),
      });
    });
  });
}

/**
 * Posts a form to the token endpoint and returns the token set it answered.
 * @param {string} tokenUrl @param {Record<string, string>} form
 * @param {{ fetch?: typeof fetch, now?: () => number }} o
 */
async function tokenRequest(tokenUrl, form, { fetch: doFetch = fetch, now = Date.now }) {
  let res;
  try {
    res = await doFetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
  } catch {
    throw new OAuthError('The sign-in server could not be reached', 'token');
  }
  /** @type {any} */
  let body = null;
  try {
    body = await res.json();
  } catch {
    throw new OAuthError('The sign-in server sent an answer that is not JSON', 'token');
  }
  // the provider's error code only: its description could echo what was sent
  if (!res.ok || typeof body?.access_token !== 'string')
    throw new OAuthError(`The sign-in server refused the request${body?.error ? ` (${String(body.error).slice(0, 64)})` : ''}`, 'token');
  const expiresIn = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === 'string' && body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now() + expiresIn * 1000 } : {}),
    scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [],
  };
}

/**
 * Exchanges an authorization code (with its PKCE verifier) for tokens.
 * @param {{ tokenUrl: string, clientId: string, code: string, verifier: string, redirectUri: string, fetch?: typeof fetch, now?: () => number }} o
 */
const exchangeCode = ({ tokenUrl, clientId, code, verifier, redirectUri, ...o }) =>
  tokenRequest(
    tokenUrl,
    { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri },
    o,
  );

/**
 * New tokens from a refresh token; a provider that sends no new refresh token keeps the old one.
 * @param {{ tokenUrl: string, clientId: string, refreshToken: string, fetch?: typeof fetch, now?: () => number }} o
 */
async function refreshTokens({ tokenUrl, clientId, refreshToken, ...o }) {
  const t = await tokenRequest(tokenUrl, { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken }, o);
  return { ...t, refreshToken: t.refreshToken ?? refreshToken };
}

module.exports = { pkce, newState, authorizeUrl, listenForCode, exchangeCode, refreshTokens, OAuthError, WAIT_MS, CALLBACK };
