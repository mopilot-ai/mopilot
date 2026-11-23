// Shared address handling for the panel, popup windows and the Chrome handoff.
import { wellFormedUriText } from './uriText.mjs';
import { withoutSecrets } from './urlSecrets.mjs';

export { isSecretParam, mayNameSecret } from './urlSecrets.mjs';

/** Without a saved token, the Playwright Extension waits for the user to approve each connection in Chrome. */
export const CHROME_APPROVAL =
  'Approve it in Chrome: click "Allow & select" on the Playwright Extension page. A connection token in Browser settings skips this step.';

export function browserUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (value === 'about:blank') return value;
  if (/^[a-z][\w+.-]*:/i.test(value) && !/^(localhost|(?:[\w-]+\.)+[\w-]+):\d+(?=[/?#]|$)/i.test(value)) {
    try {
      const u = new URL(value);
      return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null;
    } catch {
      return null;
    }
  }
  const local = /^(localhost|[\w-]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])(:\d+)?([/?#]|$)/i.test(value);
  const host = /^(?:[\w-]+\.)+[\w-]+(?::\d+)?(?:[/?#]|$)/.test(value);
  if (local || host) {
    try {
      return new URL(`${local ? 'http' : 'https'}://${value}`).href;
    } catch {
      return null;
    }
  }
  return `https://www.google.com/search?q=${encodeURIComponent(wellFormedUriText(value))}`;
}

export function isWebUrl(value) {
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function isIdentityProvider(value) {
  try {
    const { hostname } = new URL(value);
    return (
      ['accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com'].includes(hostname) ||
      hostname.endsWith('.auth0.com') ||
      hostname.endsWith('.okta.com')
    );
  } catch {
    return false;
  }
}

/** Parameters only an OAuth, OpenID, SAML or WS-Federation request or callback carries (lower case). */
const CALLBACK_PARAMS = ['client_id', 'redirect_uri', 'id_token', 'oauth_verifier', 'samlresponse', 'samlart', 'wresult'];

/**
 * The address a hand-off to the user's Chrome reopens: the task's site, never an in-flight OAuth challenge or
 * callback, and never a credential copied into another profile.
 * - An address on an identity provider is skipped; the next one (the task's site) is used.
 * - An OAuth, OpenID, SAML or WS-Federation request or callback (its path, a code with a state, or a parameter only
 *   those carry) reopens the site's root.
 * - Otherwise the path, query and fragment are kept as written, so a page addressed by its query (search results,
 *   ?id=) reopens right, without anything that may carry a credential (urlSecrets.mjs withoutSecrets).
 */
export function restartUrl(values) {
  for (const value of values) {
    if (!isWebUrl(value) || isIdentityProvider(value)) continue;
    const u = new URL(value);
    const names = new Set([...u.searchParams.keys()].map((k) => k.toLowerCase()));
    if (
      /\/(oauth|callback|authorize|saml|signin-oidc)(\/|$)/i.test(u.pathname) ||
      (names.has('code') && names.has('state')) ||
      CALLBACK_PARAMS.some((key) => names.has(key))
    ) {
      u.pathname = '/';
      u.search = '';
      u.hash = '';
      return u.href;
    }
    return withoutSecrets(u).href;
  }
  return null;
}
