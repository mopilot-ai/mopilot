// A managed server's OAuth 2.1 sign-in as the gateway's vault keeps it (#2999 C2b, credentials.cjs): the tokens, the client it registered (RFC 7591) and the authorization server it found (RFC 9728 / RFC 8414 metadata), the resource indicator (RFC 8707) and the redirect it used, so a refresh needs no second discovery. A damaged or partial entry is dropped, never guessed at (B1); an endpoint that isn't https (http only on this Mac) is not kept.

/**
 * @typedef {{ client_id: string, client_secret?: string, client_secret_expires_at?: number, token_endpoint_auth_method?: string }} OAuthClient
 * @typedef {{ issuer?: string, authorization_endpoint: string, token_endpoint: string, response_types_supported: string[],
 *   token_endpoint_auth_methods_supported?: string[], code_challenge_methods_supported?: string[], registration_endpoint?: string }} OAuthServerMetadata
 * @typedef {{ type: 'oauth', accessToken: string, refreshToken?: string, expiresAt?: number, scope?: string,
 *   authServer: string, metadata: OAuthServerMetadata, client: OAuthClient, resource?: string, redirectUri: string }} OAuthCredential
 */

const TOKEN_MAX = 16_384;
const TEXT_MAX = 2048;

const record = (/** @type {unknown} */ v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, any>} */ (v) : null;
const text = (/** @type {unknown} */ v, max = TEXT_MAX) =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;
const strings = (/** @type {unknown} */ v) =>
  Array.isArray(v) && v.length <= 32 && v.every((x) => text(x, 128)) ? /** @type {string[]} */ ([...v]) : null;

/** An endpoint the gateway sends tokens or codes to: https, or http to this Mac only; null for anything else. */
function endpoint(/** @type {unknown} */ v) {
  const s = text(v);
  if (!s) return null;
  try {
    const url = new URL(s);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    return url.protocol === 'https:' || (url.protocol === 'http:' && loopback) ? s : null;
  } catch {
    return null;
  }
}

/** The authorization server's metadata the gateway keeps (what a sign-in and a refresh read), or null. @returns {OAuthServerMetadata | null} */
function metadataOf(/** @type {unknown} */ v) {
  const m = record(v);
  const authorize = endpoint(m?.authorization_endpoint);
  const token = endpoint(m?.token_endpoint);
  const types = strings(m?.response_types_supported);
  if (!m || !authorize || !token || !types) return null;
  /** @type {OAuthServerMetadata} */
  const out = { authorization_endpoint: authorize, token_endpoint: token, response_types_supported: types };
  if (text(m.issuer)) out.issuer = m.issuer;
  const methods = strings(m.token_endpoint_auth_methods_supported);
  if (methods) out.token_endpoint_auth_methods_supported = methods;
  const pkce = strings(m.code_challenge_methods_supported);
  if (pkce) out.code_challenge_methods_supported = pkce;
  const register = endpoint(m.registration_endpoint);
  if (register) out.registration_endpoint = register;
  return out;
}

/** The registered client, or null. @returns {OAuthClient | null} */
function clientOf(/** @type {unknown} */ v) {
  const c = record(v);
  const id = text(c?.client_id);
  if (!c || !id) return null;
  /** @type {OAuthClient} */
  const out = { client_id: id };
  if (text(c.client_secret, TOKEN_MAX)) out.client_secret = c.client_secret;
  if (Number.isFinite(c.client_secret_expires_at)) out.client_secret_expires_at = c.client_secret_expires_at;
  if (text(c.token_endpoint_auth_method, 64)) out.token_endpoint_auth_method = c.token_endpoint_auth_method;
  return out;
}

/** An OAuth credential, or null when any required part is missing or malformed. @returns {OAuthCredential | null} */
function oauthCredentialOf(/** @type {unknown} */ v) {
  const c = record(v);
  if (c?.type !== 'oauth') return null;
  const accessToken = text(c.accessToken, TOKEN_MAX);
  const authServer = endpoint(c.authServer);
  const metadata = metadataOf(c.metadata);
  const client = clientOf(c.client);
  const redirectUri = endpoint(c.redirectUri);
  if (!accessToken || !authServer || !metadata || !client || !redirectUri) return null;
  /** @type {OAuthCredential} */
  const out = { type: 'oauth', accessToken, authServer, metadata, client, redirectUri };
  if (text(c.refreshToken, TOKEN_MAX)) out.refreshToken = c.refreshToken;
  if (Number.isFinite(c.expiresAt)) out.expiresAt = c.expiresAt;
  if (text(c.scope)) out.scope = c.scope;
  if (endpoint(c.resource)) out.resource = c.resource;
  return out;
}

/** When a token answered with `expires_in` expires: only a positive lifetime counts (as C1's tokenRequest takes it), else none. */
const expiresAtOf = (/** @type {unknown} */ expiresIn, /** @type {number} */ now) =>
  typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined;

module.exports = { oauthCredentialOf, metadataOf, clientOf, endpoint, expiresAtOf };
