// Groups imported cookies by site (the registrable domain) for the import dialog's checklist, and marks the sites a silent import would hurt most: banking, payments and the like (siteRisk's high class) plus email and sign-in providers.
const { classify } = require('../siteRisk.cjs');

/** Second-level suffixes under which a site is one label deeper (example.co.uk), the common ones. */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);

/** Email and sign-in providers: a cookie here is a key to many other accounts, so it is not pre-selected. */
const IDENTITY_SITES = new Set([
  'google.com',
  'microsoft.com',
  'live.com',
  'outlook.com',
  'office.com',
  'microsoftonline.com',
  'apple.com',
  'icloud.com',
  'yahoo.com',
  'proton.me',
  'protonmail.com',
  'fastmail.com',
  'okta.com',
  'auth0.com',
  'login.gov',
  'id.me',
]);

/** The site a cookie host belongs to: "docs.example.co.uk" → "example.co.uk", an IP address or single label as it is. */
function siteOf(host) {
  const h = String(host ?? '')
    .toLowerCase()
    .replace(/^\./, '')
    .replace(/\.$/, '');
  if (!h || /^[\d.]+$/.test(h) || h.includes(':') || !h.includes('.')) return h;
  const labels = h.split('.');
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  const depth = tld.length === 2 && SECOND_LEVEL.has(second) && labels.length >= 3 ? 3 : 2;
  return labels.slice(-depth).join('.');
}

/**
 * Why a site is not pre-selected, or null: its risk class's label, or a note for email and sign-in providers.
 * @returns {string | null}
 */
function sensitiveReason(site) {
  const risk = classify(`https://${site}/`);
  if (risk.level === 'high') return risk.label;
  return IDENTITY_SITES.has(site) ? 'Email or sign-in provider' : null;
}

/** The site of a saved login's origin ("https://accounts.example.com" → "example.com"). */
const siteOfOrigin = (origin) => siteOf(new URL(origin).hostname);

/**
 * The checklist: [{ site, count, logins, sensitive, reason }] (count: cookies, logins: saved passwords), busiest
 * site first.
 * @param {{ host: string }[]} cookies
 * @param {{ origin: string }[]} [logins]
 */
function groupCookies(cookies, logins = []) {
  /** @type {Map<string, { count: number, logins: number }>} */
  const by = new Map();
  const add = (site, field) => {
    if (!site) return;
    const row = by.get(site) ?? { count: 0, logins: 0 };
    row[field]++;
    by.set(site, row);
  };
  for (const c of cookies) add(siteOf(c.host), 'count');
  for (const l of logins) add(siteOfOrigin(l.origin), 'logins');
  return [...by]
    .map(([site, n]) => {
      const reason = sensitiveReason(site);
      return { site, count: n.count, logins: n.logins, sensitive: reason !== null, reason };
    })
    .sort((a, b) => b.count + b.logins - (a.count + a.logins) || a.site.localeCompare(b.site));
}

module.exports = { siteOf, siteOfOrigin, sensitiveReason, groupCookies, IDENTITY_SITES };
