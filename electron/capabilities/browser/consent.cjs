// OAuth and app-access consent, for every browser route (#1619): the in-page test the page agent and the Chrome intent reader share, and what the card says about the grant.
//
// Granting a third-party app access to the user's account is the user's decision, as Claude in Chrome and ChatGPT's agent
// treat it: what an action acts on (pageAgent.cjs intent, chromeIntent.cjs INTENT_OF) carries `consent: { app, scopes }`
// when it is a grant control ("Allow", "Authorize <app>", "Accept", "Continue", "Install & authorize") on a consent page,
// and siteRisk.cjs sensitiveAction() names it `oauth_consent`, which asks in every mode, Full access included.
// A consent page is an OAuth/OpenID authorization address (an oauth, authorize or consent path with a client_id,
// response_type or redirect_uri, or such a path on a known identity provider, or a GitHub App installation), or a page
// whose title or heading says an app wants access to the user's account. A control inside a cookie banner is never one.

/**
 * Whether an address is an OAuth/OpenID consent or app-installation page. Self-contained: it is serialized into the page.
 * @param {string} href
 * @returns {boolean}
 */
function consentUrl(href) {
  let u;
  try {
    u = new URL(String(href));
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  if (host === 'github.com' && /^\/apps\/[^/]+\/installations\/(?:new|select_target)/.test(path)) return true;
  if (!/\/(?:oauth2?|authori[sz]e|consent(?:summary)?|dialog\/oauth)(?:[/.]|$)/i.test(path)) return false;
  const keys = [...u.searchParams.keys()].map((k) => k.toLowerCase());
  if (keys.some((k) => k === 'client_id' || k === 'response_type' || k === 'redirect_uri')) return true;
  const IDP =
    /(?:^|\.)(?:accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|github\.com|slack\.com|discord\.com|auth\.atlassian\.com|okta\.com|auth0\.com|onelogin\.com|dropbox\.com|zoom\.us|linkedin\.com|facebook\.com|x\.com|twitter\.com)$/;
  return IDP.test(host);
}

/**
 * Whether a control's name grants what a consent page asks ("Allow", "Authorize Acme", "Accept", "Continue"); "Cancel",
 * "Deny" and "Accept all" (a cookie banner's) are not. Self-contained: it is serialized into the page.
 * @param {string} name
 * @returns {boolean}
 */
function grantName(name) {
  const s = String(name || '')
    .replace(/\s+/g, ' ')
    .trim();
  return (
    s.length <= 80 &&
    /^(?:allow(?: access)?|authori[sz]e\b.*|grant(?: access| permissions?)?|approve|accept(?: (?:and|&) continue)?|consent|i (?:agree|consent)|agree(?: (?:and|&) continue)?|continue(?: as\b.*)?|yes(?:,? (?:allow|continue|i agree))?|confirm|connect\b.*|install(?: (?:and|&) authori[sz]e\b.*)?|link (?:my |your )?accounts?|share)[.!]?$/i.test(
      s,
    )
  );
}

/**
 * What a grant control on a consent page grants: { app, scopes }, or null when the control is no grant or the page no
 * consent page. Runs in the page (serialized with CONSENT_SOURCE, which passes the two tests in), so it must not close
 * over anything. `hit`: the element at the target; `el`: the control it belongs to; `name`: that control's name.
 * @param {Element} hit
 * @param {Element} el
 * @param {string} name
 * @returns {{ app: string, scopes: string[] } | null}
 */
function consentIn(hit, el, name, urlTest = consentUrl, nameTest = grantName) {
  if (!nameTest(name)) return null;
  // text the page always has (a title, an element's text), never null
  const clean = (/** @type {unknown} */ s) => String(s).replace(/\s+/g, ' ').trim();
  // a cookie or privacy banner's "Allow" or "Accept" is never an app's access
  for (let e = /** @type {Element | null} */ (hit); e && e.localName !== 'body'; e = e.parentElement)
    if (
      /cookie|gdpr|onetrust|didomi|usercentrics|trustarc|\bcmp-(?:banner|wrapper|modal|ui)\b|privacy-banner/i.test(
        `${e.id} ${e.getAttribute('class') || ''}`,
      )
    )
      return null;
  const doc = el.ownerDocument;
  const heads = [doc.title, ...[...doc.querySelectorAll('h1, h2, [role="heading"]')].slice(0, 6).map((h) => h.textContent)].map(clean);
  const ASKS = /\b(?:wants|would like|is requesting|requests|is asking for|needs)\b.{0,40}\b(?:access|permission)\b/i;
  if (!urlTest(doc.URL) && !heads.some((h) => ASKS.test(h))) return null;
  // the app: "Acme wants to access…", "Authorize Acme", "Sign in to Acme", "…to continue to Acme", else the button's "Authorize Acme"
  const APP = [
    /^(.{1,60}?)\s+(?:wants|would like|is requesting|requests|is asking for|needs)\b/i,
    /^(?:authori[sz]e|sign in to|connect(?: to)?|install)\s+(.{1,60}?)\s*[.!?]?$/i,
    /\bto continue to\s+(.{1,60}?)\s*[.!?]?$/i,
  ];
  let app = '';
  for (const h of [...heads, clean(name)]) {
    for (const re of APP) app ||= re.exec(h)?.[1] || '';
    if (app) break;
  }
  // the scopes: the list items of the form or main area the control is in, as the page shows them
  const box = el.closest('form') || el.closest('main, [role="main"]') || doc.body;
  const scopes = [...box.querySelectorAll('li')]
    .map((li) => clean(li.textContent))
    .filter((s) => s.length >= 2 && s.length <= 100)
    .slice(0, 6);
  return { app: app.slice(0, 60), scopes };
}

/** consentIn with its two tests, as a function expression for the page agent and the Chrome intent reader. */
const CONSENT_SOURCE = `(hit, el, name) => (${consentIn.toString()})(hit, el, name, ${consentUrl.toString()}, ${grantName.toString()})`;

/** What a consent card asks: "grant Acme access to your account". */
const consentVerb = (/** @type {{ app?: string } | null | undefined} */ c) => `grant ${c?.app || 'an app'} access to your account`;

/** What a consent card names: the app and the scopes the page lists, else the control's name. */
function consentDetail(/** @type {{ app?: string, scopes?: string[] }} */ c, /** @type {string} */ name) {
  const scopes = (c.scopes || []).join('; ');
  return [c.app || name, scopes].filter(Boolean).join(': ');
}

module.exports = { consentIn, consentUrl, grantName, CONSENT_SOURCE, consentVerb, consentDetail };
