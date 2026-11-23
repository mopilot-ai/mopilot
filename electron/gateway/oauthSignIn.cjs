// Signing in to a managed server with OAuth 2.1 (#2999 C2b), on the SDK's own client pieces (@modelcontextprotocol/sdk client/auth.js): discovery of the server's protected-resource metadata (RFC 9728) and its authorization server's metadata (RFC 8414), dynamic client registration (RFC 7591) for this sign-in's loopback redirect, PKCE (S256) and the resource indicator (RFC 8707) on both the authorization and the token request, the system browser for the user's consent, and C1's one-shot loopback listener (oauth.cjs) for the code. Nothing here opens a browser except a sign-in the user started; an endpoint that isn't https (http only on this Mac) is refused. Failures say which step failed, never the server's own words.
const {
  discoverOAuthServerInfo,
  registerClient,
  startAuthorization,
  exchangeAuthorization,
  selectResourceURL,
} = require('@modelcontextprotocol/sdk/client/auth.js');
const { resourceUrlFromServerUrl } = require('@modelcontextprotocol/sdk/shared/auth-utils.js');
const { listenForCode, newState } = require('./oauth.cjs');
const { oauthCredentialOf, metadataOf, clientOf, endpoint, expiresAtOf } = require('./oauthCredential.cjs');

/** What a failed step tells the user. */
const TEXT = {
  discovery: 'MoPilot couldn’t find where to sign in to this server',
  resource: 'This server’s sign-in names another server, so MoPilot didn’t sign in',
  registration: 'This server’s sign-in doesn’t let MoPilot register itself, so it can’t sign in yet',
  token: 'The sign-in server didn’t give MoPilot a token',
  open: 'MoPilot couldn’t open the sign-in page in the browser',
};

/** A sign-in step failed: `code` discovery, resource, registration, open, token, or the listener's denied, timeout or closed. */
class SignInError extends Error {
  /** @param {keyof typeof TEXT | 'denied' | 'timeout' | 'closed'} code @param {string} [message] */
  constructor(code, message) {
    super(message ?? TEXT[/** @type {keyof typeof TEXT} */ (code)]);
    this.code = code;
  }
}

/** Runs `step`; any failure becomes the SignInError of `code`. @template T @param {string} code @param {() => Promise<T>} step */
async function at(code, step) {
  try {
    return await step();
  } catch {
    throw new SignInError(/** @type {any} */ (code));
  }
}

/**
 * One sign-in: resolves with the credential to save, or rejects with a SignInError. `signal` cancels it (the user
 * signed out or removed the server meanwhile): the listener closes and nothing is exchanged.
 * @param {{ url: string, open: (url: string) => Promise<unknown>, signal?: AbortSignal | null, fetch?: typeof fetch,
 *   listen?: typeof listenForCode, clientName?: string, now?: () => number }} o url: the server's streamable HTTP URL
 * @returns {Promise<import('./oauthCredential.cjs').OAuthCredential>}
 */
async function signIn({
  url,
  open,
  signal = null,
  fetch: fetchFn = fetch,
  listen = listenForCode,
  clientName = 'MoPilot',
  now = Date.now,
}) {
  const info = await at('discovery', () => discoverOAuthServerInfo(url, { fetchFn }));
  const metadata = metadataOf(info.authorizationServerMetadata);
  const authServer = endpoint(info.authorizationServerUrl);
  if (!metadata || !authServer) throw new SignInError('discovery');
  // the server's own resource indicator when it publishes one (checked against its URL), else its canonical URL
  // (no provider: the SDK's own check, against the server URL)
  await at('resource', () => selectResourceURL(url, /** @type {any} */ ({}), info.resourceMetadata));
  const resource = info.resourceMetadata?.resource ?? resourceUrlFromServerUrl(url).href;
  const scopes = info.resourceMetadata?.scopes_supported;
  const scope = Array.isArray(scopes) && scopes.length ? scopes.join(' ') : undefined;
  if (!metadata.registration_endpoint) throw new SignInError('registration');
  const state = newState();
  const listener = await listen({ state });
  const cancel = () => listener.close();
  signal?.addEventListener('abort', cancel, { once: true });
  /** cancelled (signed out, removed) at any step: nothing more is sent or opened */
  const live = () => {
    if (signal?.aborted) throw new SignInError('closed', 'The sign-in was cancelled');
  };
  try {
    live();
    const client = clientOf(
      await at('registration', () =>
        registerClient(authServer, {
          metadata: /** @type {any} */ (metadata),
          clientMetadata: {
            client_name: clientName,
            redirect_uris: [listener.redirectUri],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
          },
          ...(scope ? { scope } : {}),
          fetchFn,
        }),
      ),
    );
    if (!client) throw new SignInError('registration');
    const { authorizationUrl, codeVerifier } = await at('discovery', () =>
      startAuthorization(authServer, {
        metadata: /** @type {any} */ (metadata),
        clientInformation: client,
        redirectUrl: listener.redirectUri,
        ...(scope ? { scope } : {}),
        state,
        resource,
      }),
    );
    live();
    await at('open', () => open(authorizationUrl.href));
    let code;
    try {
      code = await listener.code;
    } catch (error) {
      // the listener's own: denied, timeout or closed
      throw new SignInError(/** @type {any} */ (error).code, /** @type {Error} */ (error).message);
    }
    // cancelled while the browser came back: nothing is exchanged
    live();
    const tokens = await at('token', () =>
      exchangeAuthorization(authServer, {
        metadata: /** @type {any} */ (metadata),
        clientInformation: client,
        authorizationCode: code,
        codeVerifier,
        redirectUri: listener.redirectUri,
        resource,
        fetchFn,
      }),
    );
    const credential = oauthCredentialOf({
      type: 'oauth',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: expiresAtOf(tokens.expires_in, now()),
      scope: tokens.scope ?? scope,
      authServer,
      metadata,
      client,
      resource,
      redirectUri: listener.redirectUri,
    });
    if (!credential) throw new SignInError('token');
    return credential;
  } finally {
    signal?.removeEventListener('abort', cancel);
    listener.close();
  }
}

module.exports = { signIn, SignInError };
