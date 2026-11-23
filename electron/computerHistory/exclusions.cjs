// Computer History's exclusions (#1363): the apps and sites it never records, whatever the allow list says. MoPilot's own no-go floor (computer use's built-in deny list, MoPilot itself and the Electron runtime), the user's computer-use deny list, the in-app browser's high-risk sites (banking, payments, brokerage, crypto, password managers, account security, government identity, private network) and a health list of its own.
const { BUILT_IN_DENY } = require('../capabilities/computerContract.cjs');
const { HOST_BUNDLES, matches } = require('../capabilities/contract/desktopPolicy.cjs');
const { classify } = require('../capabilities/browser/siteRisk.cjs');
const { decodeSegment } = require('./redact.cjs');

/** Apps that can show a screen nobody should record, beyond computer use's floor. */
const EXTRA_APPS = Object.freeze([
  { pattern: 'com.apple.ScreenSaver.Engine', reason: 'screen saver' },
  { pattern: 'com.apple.screensaver', reason: 'screen saver' },
  { pattern: 'com.apple.coreautha', reason: 'authentication prompt' },
  { pattern: 'com.apple.ScreenContinuity', reason: 'iPhone Mirroring' },
]);

/** The apps Computer History never records, as Settings lists them. */
const NEVER_APPS = Object.freeze([
  ...BUILT_IN_DENY,
  ...HOST_BUNDLES.filter((p) => !BUILT_IN_DENY.some((d) => d.pattern === p)).map((pattern) => ({ pattern, reason: 'MoPilot' })),
  ...EXTRA_APPS,
]);

/** Health sites: patient portals, pharmacies, telehealth, labs and medical reference. */
const HEALTH_DOMAINS = Object.freeze([
  'mychart.com',
  'mychartlogin.com',
  'followmyhealth.com',
  'athenahealth.com',
  'patientportal.com',
  'kp.org',
  'kaiserpermanente.org',
  'onemedical.com',
  'zocdoc.com',
  'teladoc.com',
  'amwell.com',
  'mdlive.com',
  'betterhelp.com',
  'talkspace.com',
  'cerebral.com',
  'hims.com',
  'forhers.com',
  'ro.co',
  'nurx.com',
  'goodrx.com',
  'cvs.com',
  'walgreens.com',
  'riteaid.com',
  'express-scripts.com',
  'optumrx.com',
  'labcorp.com',
  'questdiagnostics.com',
  '23andme.com',
  'healthcare.gov',
  'medicare.gov',
  'webmd.com',
  'mayoclinic.org',
  'healthline.com',
  'clevelandclinic.org',
  'nhs.uk',
]);

/** Host words that mark a health site (a whole label or the start of one, so "health" matches myhealth.example). */
const HEALTH_HOST = /(^|[.-])[a-z0-9]*(health|medical|patient|clinic|hospital|pharmacy|mychart|telehealth|dental|therapy)[a-z0-9-]*\./i;

/** Hosts that sign the user in to MoPilot or a harness vendor, and MoPilot's own sites. */
const OWN_AND_SIGN_IN = Object.freeze([
  'mopilot.ai',
  'auth.openai.com',
  'auth0.openai.com',
  'login.microsoftonline.com',
  'accounts.google.com',
  'appleid.apple.com',
  'idmsa.apple.com',
  'github.com/login',
  'github.com/session',
  'github.com/settings',
  'claude.ai/login',
  'console.anthropic.com/login',
  'platform.openai.com/login',
]);

/** Host words that mark a sign-in host (sso.example.com, login.example.com). */
const SIGN_IN_HOST = /^(login|signin|sso|auth|oauth|idp|id|accounts?|passport)\./i;

/** `host` is `domain` or under it. */
const underDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);

/**
 * Why Computer History never records this app, or null.
 * @param {string | null | undefined} bundleId
 * @param {string[]} [userDeny] the user's computer-use deny list (bundle ids or "prefix.*")
 */
function appExclusion(bundleId, userDeny = []) {
  if (typeof bundleId !== 'string' || !bundleId) return 'unknown app';
  const rule = NEVER_APPS.find((r) => matches(r.pattern, bundleId));
  if (rule) return rule.reason;
  if (userDeny.some((p) => typeof p === 'string' && matches(p, bundleId))) return 'blocked in Settings → Computer use';
  return null;
}

/**
 * Why Computer History never records this page, or null. Anything that is not an http(s) URL is excluded.
 * @param {string | null | undefined} url
 */
function siteExclusion(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return 'not a web page';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'not a web page';
  const risk = classify(u.href);
  if (risk.level !== 'normal') return risk.label;
  if (risk.credentials) return 'sign-in details in the address';
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (HEALTH_DOMAINS.some((d) => underDomain(host, d)) || HEALTH_HOST.test(`${host}.`)) return 'Health site';
  // paths compare decoded and in lower case: /Settings and /%73ettings are the same page to most sites
  const pathname = decodeSegment(u.pathname).toLowerCase();
  for (const entry of OWN_AND_SIGN_IN) {
    const [domain, ...rest] = entry.split('/');
    const prefix = rest.length ? `/${rest.join('/')}` : '';
    if (underDomain(host, domain) && (!prefix || pathname === prefix || pathname.startsWith(`${prefix}/`)))
      return domain === 'mopilot.ai' ? 'MoPilot' : 'Sign-in page';
  }
  if (SIGN_IN_HOST.test(host)) return 'Sign-in page';
  return null;
}

module.exports = { NEVER_APPS, HEALTH_DOMAINS, appExclusion, siteExclusion, underDomain };
