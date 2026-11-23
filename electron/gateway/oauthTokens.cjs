// A managed server's OAuth access token, as each of the gateway's requests to it needs one (#2999 C2b): read from the vault here in main, refreshed (the SDK's refreshAuthorization, with the client and resource indicator the sign-in kept) once it is within REFRESH_EARLY_MS (or half its lifetime, for a short-lived one) of expiring or the server answers 401, one refresh per saved sign-in at a time, each bounded by REFRESH_MS. A refresh saves its tokens only while the vault still holds the tokens it started from, so a sign-out, a new sign-in or another MoPilot's refresh meanwhile is never overwritten (A4). A refresh the authorization server refuses ends the sign-in: the server needs signing in again, and its owner hears it (onSignedOut) so the server stops offering tools that can't run. The token goes only on requests to the server's own origin.
const { refreshAuthorization } = require('@modelcontextprotocol/sdk/client/auth.js');
const { NeedsCredentialError } = require('./auth.cjs');
const { expiresAtOf } = require('./oauthCredential.cjs');

/** How early a token is refreshed before it expires (at most half its lifetime). */
const REFRESH_EARLY_MS = 60_000;
/** The longest a refresh may take: a token endpoint that never answers must not hold the server's requests or a restart. */
const REFRESH_MS = 30_000;

/** @typedef {import('./oauthCredential.cjs').OAuthCredential} OAuthCredential */

/** The token endpoint's answers that end a sign-in (RFC 6749 §5.2): anything else (a 500, a network failure) is tried again later. */
const SIGNED_OUT = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_scope']);

/** Whether a credential is still the one a refresh started from (its tokens, not its save time). */
const same = (/** @type {any} */ a, /** @type {OAuthCredential} */ b) =>
  a?.type === 'oauth' && a.accessToken === b.accessToken && a.refreshToken === b.refreshToken;

class OAuthTokens {
  /**
   * @param {{ vault: InstanceType<typeof import('./credentials.cjs').CredentialVault>, now?: () => number, fetch?: typeof fetch,
   *   refresh?: typeof refreshAuthorization, refreshMs?: number, onSignedOut?: (key: string) => void }} o
   *   onSignedOut: a server's sign-in ended (a refused refresh, no refresh token): it needs signing in again
   */
  constructor({
    vault,
    now = Date.now,
    fetch: doFetch = fetch,
    refresh = refreshAuthorization,
    refreshMs = REFRESH_MS,
    onSignedOut = () => undefined,
  }) {
    this.vault = vault;
    this.now = now;
    this.fetchFn = doFetch;
    this.refreshFn = refresh;
    this.refreshMs = refreshMs;
    this.onSignedOut = onSignedOut;
    /** @type {Map<string, Promise<string>>} each saved sign-in's refresh in flight, by server and the tokens it started from */
    this.refreshing = new Map();
  }

  /** The server's OAuth credential, or NeedsCredentialError. SealedUnavailableError passes through (locked, never "signed out"). */
  #credential(/** @type {string} */ key) {
    const c = this.vault.get(key);
    if (c?.type !== 'oauth') throw new NeedsCredentialError();
    return /** @type {OAuthCredential} */ (c);
  }

  /** A token for the server's next request: the saved one, or a fresh one when it expires within its early margin. */
  async access(/** @type {string} */ key) {
    const c = /** @type {OAuthCredential & { savedAt?: number }} */ (this.#credential(key));
    if (c.expiresAt === undefined) return c.accessToken;
    // a token that lives less than two minutes is refreshed at half its life, not on every request
    const margin = Math.min(REFRESH_EARLY_MS, Math.max(0, (c.expiresAt - /** @type {number} */ (c.savedAt)) / 2));
    if (c.expiresAt - margin > this.now()) return c.accessToken;
    return this.refresh(key, c);
  }

  /**
   * A new access token from the saved refresh token; a second caller while one runs gets the same one. `seen`: the
   * credential the caller found stale (a 401's): a refresh another caller finished since answers with its token.
   * @param {string} key @param {OAuthCredential} [seen]
   */
  async refresh(key, seen) {
    const c = this.#credential(key);
    if (seen && !same(c, seen)) return c.accessToken;
    // joined only by callers refreshing the same saved sign-in: a newer one never inherits an older one's failure
    const id = JSON.stringify([key, c.accessToken, c.refreshToken ?? null]);
    const running = this.refreshing.get(id);
    if (running) return running;
    const p = this.#refresh(key, c).finally(() => {
      if (this.refreshing.get(id) === p) this.refreshing.delete(id);
    });
    this.refreshing.set(id, p);
    return p;
  }

  async #refresh(/** @type {string} */ key, /** @type {OAuthCredential} */ c) {
    if (!c.refreshToken) throw await this.#signedOut(key, c);
    let tokens;
    try {
      tokens = await this.refreshFn(c.authServer, {
        metadata: /** @type {any} */ (c.metadata),
        clientInformation: c.client,
        refreshToken: c.refreshToken,
        ...(c.resource ? { resource: c.resource } : {}),
        // bounded: an endpoint that never answers fails this refresh, and the next request tries again
        fetchFn: (/** @type {any} */ url, /** @type {any} */ init) =>
          this.fetchFn(url, { ...init, signal: AbortSignal.timeout(this.refreshMs) }),
      });
    } catch (error) {
      // the server said no (invalid_grant and the like): this sign-in is over; a network failure leaves it for the next try
      if (SIGNED_OUT.has(/** @type {any} */ (error)?.errorCode)) throw await this.#signedOut(key, c);
      throw error;
    }
    const next = {
      ...c,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? c.refreshToken,
      expiresAt: expiresAtOf(tokens.expires_in, this.now()),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
    };
    const kept = await this.vault.replaceIf(key, (saved) => same(saved, c), next);
    // a sign-out or a new sign-in came first: theirs stands, and this request uses what is saved now
    return kept ? next.accessToken : this.#credential(key).accessToken;
  }

  /** The refresh token is gone or refused: the saved sign-in is forgotten (if it is still this one) and the server needs one. */
  async #signedOut(/** @type {string} */ key, /** @type {OAuthCredential} */ c) {
    // still this sign-in: it is forgotten and the owner hears it; a newer one meanwhile stands, untouched
    if (await this.vault.replaceIf(key, (saved) => same(saved, c), null)) this.onSignedOut(key);
    return new NeedsCredentialError();
  }

  /**
   * The fetch the server's transport uses: each request to `origin` carries the current token; a 401 refreshes once and
   * tries again. A request anywhere else goes out without it.
   * @param {string} key @param {string} origin the server URL's origin
   * @returns {(url: string | URL, init?: RequestInit) => Promise<Response>}
   */
  fetchFor(key, origin) {
    const send = (/** @type {string | URL} */ url, /** @type {RequestInit | undefined} */ init, /** @type {string} */ token) => {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${token}`);
      return this.fetchFn(url, { ...init, headers });
    };
    return async (url, init) => {
      if (new URL(String(url)).origin !== origin) return this.fetchFn(url, init);
      // signed out elsewhere (another MoPilot, or meanwhile here): the owner hears it, so the server stops offering tools
      if (this.vault.get(key)?.type !== 'oauth') {
        this.onSignedOut(key);
        throw new NeedsCredentialError();
      }
      const token = await this.access(key);
      const res = await send(url, init, token);
      if (res.status !== 401) return res;
      await res.body?.cancel();
      // another request refreshed meanwhile: its token; else this one refreshes (and joins one already running)
      const now = this.#credential(key);
      return send(url, init, now.accessToken !== token ? now.accessToken : await this.refresh(key, now));
    };
  }
}

module.exports = { OAuthTokens, REFRESH_EARLY_MS, REFRESH_MS };
