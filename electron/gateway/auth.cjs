// How a managed server's credential reaches it (#2999 C2): on the gateway's own HTTP requests only, as an Authorization header (bearer, basic; OAuth's read and refreshed per request by oauthTokens.cjs) or a URL parameter, added after the server's configured headers are filled, so a credential is never read as a ${VAR}. A server whose kind of sign-in has no credential saved is not connected, and says so.

/**
 * @typedef {import('./servers.cjs').ManagedServer} ManagedServer
 * @typedef {import('./credentials.cjs').Credential} Credential
 * @typedef {{ headers: Record<string, string>, url: string | null, fetch?: (url: string | URL, init?: RequestInit) => Promise<Response> }} RequestAuth
 *   extra headers, the URL to use instead of the launch's, and for OAuth the fetch that puts the current token on each request
 */

/** A server that takes a credential has none saved (or one of another kind): it needs the user to connect it. */
class NeedsCredentialError extends Error {
  constructor() {
    super('It needs to be connected first');
    this.code = 'needs_credentials';
  }
}

/**
 * What the gateway adds to a server's requests for its credential.
 * @param {ManagedServer} server @param {Credential | null} credential
 * @param {{ fetchFor(key: string, origin: string): NonNullable<RequestAuth['fetch']> } | null} [tokens] OAuth's token source (oauthTokens.cjs)
 * @returns {RequestAuth}
 */
function requestAuth(server, credential, tokens = null) {
  if (server.auth === 'none' || server.launch.type !== 'http') return { headers: {}, url: null };
  if (!credential || credential.type !== server.auth) throw new NeedsCredentialError();
  // OAuth: the token is read (and refreshed) per request, never fixed into the connection
  if (credential.type === 'oauth' && tokens)
    return { headers: {}, url: null, fetch: tokens.fetchFor(server.key, new URL(server.launch.url).origin) };
  if (credential.type === 'oauth') throw new NeedsCredentialError();
  if (credential.type === 'bearer') return { headers: { Authorization: `Bearer ${credential.token}` }, url: null };
  if (credential.type === 'basic') {
    const pair = Buffer.from(`${credential.username}:${credential.password}`, 'utf8').toString('base64');
    return { headers: { Authorization: `Basic ${pair}` }, url: null };
  }
  const url = new URL(server.launch.url);
  url.searchParams.set(credential.param, credential.value);
  return { headers: {}, url: url.href };
}

module.exports = { requestAuth, NeedsCredentialError };
