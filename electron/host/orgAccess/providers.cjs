// How an organization's model access is authorized (#3361 Tier 2): one typed adapter per source, each turning the person's IdP sign-in into the token and gateway addresses a lease carries. `gateway` (the customer's LLM gateway takes the IdP's own access token) is the one v1 offers; `wif` (an IdP token exchanged for a short-lived vendor token, RFC 8693) and `staticKey` (an org API key behind the customer's own controls) are kept as adapters, unverified against a vendor.
const { baseUrlOf } = require('../../../shared/host/orgAccess.mjs');

/** @typedef {Partial<Record<'anthropic' | 'openai', string>>} Gateways */
/** @typedef {{ accessToken: string, idToken?: unknown, expiresAt: number }} SignedIn what the IdP gave for the person */
/** @typedef {{ token: string, gateways: Gateways, expiresAt: number }} Minted */
/** @typedef {{ kind: 'gateway', gateways: Gateways } | { kind: 'wif', exchangeUrl: string, audience: string, gateways: Gateways } | { kind: 'staticKey', gateways: Gateways }} Access */

const refusal = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** The gateway addresses the admin gave, checked; at least one. @param {unknown} g @returns {Gateways} */
function gatewaysOf(g) {
  /** @type {Gateways} */
  const out = {};
  for (const k of /** @type {const} */ (['anthropic', 'openai'])) {
    const v = /** @type {any} */ (g)?.[k];
    if (v == null || v === '') continue;
    const url = baseUrlOf(v);
    if (!url) throw refusal(`The ${k === 'anthropic' ? 'Anthropic' : 'OpenAI'} gateway address must be https.`, 'invalid');
    out[k] = url;
  }
  if (!Object.keys(out).length) throw refusal('Give at least one gateway address.', 'invalid');
  return out;
}

/** The admin's access settings, checked. @param {unknown} a @returns {Access} */
function accessOf(a) {
  const o = /** @type {any} */ (a ?? {});
  const gateways = gatewaysOf(o.gateways);
  if (o.kind === 'gateway' || o.kind == null) return { kind: 'gateway', gateways };
  if (o.kind === 'staticKey') return { kind: 'staticKey', gateways };
  if (o.kind === 'wif') {
    const exchangeUrl = baseUrlOf(o.exchangeUrl);
    if (!exchangeUrl) throw refusal('The token exchange address must be https.', 'invalid');
    if (typeof o.audience !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(o.audience))
      throw refusal('Give the federation audience.', 'invalid');
    return { kind: 'wif', exchangeUrl, audience: o.audience, gateways };
  }
  throw refusal('That is not a kind of organization access.', 'invalid');
}

/**
 * The adapter for `access`. `mint` turns the person's sign-in into a lease's token; `needsSignIn` says whether it needs one at all.
 * @param {Access} access
 * @param {{ fetch?: typeof fetch, staticKey?: () => string | null }} [o] staticKey: the org key from the app's encrypted store
 * @returns {{ kind: Access['kind'], needsSignIn: boolean, mint: (signedIn: SignedIn | null, now: number) => Promise<Minted> }}
 */
function providerFor(access, { fetch: fetchFn = globalThis.fetch, staticKey = () => null } = {}) {
  if (access.kind === 'gateway')
    return {
      kind: 'gateway',
      needsSignIn: true,
      // the gateway checks the IdP's own token (its signature, audience and end): the token is the lease
      mint: async (signedIn) => {
        if (!signedIn) throw refusal('Sign in to your organization again.', 'signin_required');
        return { token: signedIn.accessToken, gateways: access.gateways, expiresAt: signedIn.expiresAt };
      },
    };
  if (access.kind === 'staticKey')
    return {
      kind: 'staticKey',
      needsSignIn: false,
      // a key has no end of its own: the lease ends with the admin's hours (the caller caps it)
      mint: async (_signedIn, now) => {
        const key = staticKey();
        if (!key) throw refusal('Add the organization key in Settings.', 'invalid');
        return { token: key, gateways: access.gateways, expiresAt: now + 24 * 3_600_000 };
      },
    };
  return {
    kind: 'wif',
    needsSignIn: true,
    // RFC 8693: the IdP's token for a short-lived one the exchange issues; each exchange takes the token as it is now
    mint: async (signedIn, now) => {
      if (!signedIn) throw refusal('Sign in to your organization again.', 'signin_required');
      const subject = typeof signedIn.idToken === 'string' ? signedIn.idToken : signedIn.accessToken;
      /** @type {Response} */
      let res;
      /** @type {any} */
      let body;
      try {
        res = await fetchFn(access.exchangeUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          redirect: 'error',
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            subject_token: subject,
            subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
            audience: access.audience,
          }).toString(),
        });
        body = JSON.parse((await res.text()).slice(0, 1 << 20));
      } catch {
        throw refusal("Couldn't reach the token exchange. Try again.", 'unreachable');
      }
      if (!res.ok || typeof body?.access_token !== 'string')
        throw res.status === 401 || body?.error === 'invalid_grant'
          ? refusal('Sign in to your organization again.', 'signin_required')
          : refusal(`The token exchange refused it (${String(body?.error ?? res.status).slice(0, 60)}).`, 'invalid');
      const expiresAt = Number.isFinite(body.expires_in) ? now + body.expires_in * 1000 : signedIn.expiresAt;
      return { token: body.access_token, gateways: access.gateways, expiresAt };
    },
  };
}

module.exports = { providerFor, accessOf, gatewaysOf };
