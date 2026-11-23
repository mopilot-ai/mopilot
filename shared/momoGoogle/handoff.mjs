// The client's half of MoMo's Google sign-in, pure of any platform: read the browser's redirect and seal it to the home's one-time key. Used by the Mac app and the phone alike.

/** What a client sends the home after the redirect: the code (or the provider's error word), the state it saw and the redirect it used. */
/** @typedef {{ state: string, redirectUri: string, code?: string, error?: string }} Handoff */

/** The context a hand-off is sealed under: one flow only. @param {string} flowId */
export const handoffContext = (flowId) => `google-consent:${flowId}`;

/**
 * Seals what the redirect carried to the home's one-time key. The relay and the phone see only this text.
 * @param {import('./seal.mjs').Sealer} sealer @param {string} flowId @param {string} sealTo @param {Handoff} hand
 */
export const sealHandoff = (sealer, flowId, sealTo, hand) => sealer.seal(sealTo, JSON.stringify(hand), handoffContext(flowId));

/**
 * Reads a redirect request's URL into a hand-off; null when it is not the redirect of this flow (another path, no state, neither code nor error).
 * @param {string} requestUrl @param {string} redirectUri @returns {Handoff | null}
 */
export function parseCallback(requestUrl, redirectUri) {
  const url = new URL(requestUrl, redirectUri);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (url.pathname !== new URL(redirectUri).pathname || !state || (!code && !error)) return null;
  return { state, redirectUri, ...(code ? { code } : { error: /** @type {string} */ (error) }) };
}
