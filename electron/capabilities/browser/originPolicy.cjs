// Pure browser-origin normalization, grant decisions, and permission-card display values.
const LEVELS = ['read', 'write'];
/** The browsers that keep their own site table: the in-app browser and the user's own Chrome. */
const BROWSERS = ['iab', 'chrome'];

/** The origin a grant covers, or null for a URL agents may not open (only http and https pages). */
function originOf(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // "example.com." is the same site as "example.com": one origin, so a denial or a grant covers both spellings
  return u.origin.replace(/\.(?=(?::\d+)?$)/, '');
}

/** Loopback hosts: a local server changes from project to project, so it is never allowed for good by the browser_* tools. */
function isLoopback(origin) {
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127\./.test(h);
  } catch {
    return false;
  }
}

/** Pages no site permission is needed for: nothing loaded yet. */
const isBlank = (url) => !url || url === 'about:blank';
/** The site a tab is on, for noticing that it moved: a tab that has not reported a page yet ('') and a blank page are the same place. @param {string} url */
const siteOf = (url) => originOf(url) || (isBlank(url) ? '' : url);

/** What a card shows about a risky site: the class, its label and why. */
const riskView = (r) => ({
  level: r.level,
  category: r.category,
  label: r.label,
  explanation: r.explanation,
  financial: r.financial,
  credentials: r.credentials,
});

/** A URL for a message, without the user name and password it may carry. */
function shown(url) {
  try {
    const u = new URL(String(url));
    u.username = '';
    u.password = '';
    return u.toString().slice(0, 200);
  } catch {
    return String(url).slice(0, 200);
  }
}

/** What a refused write on a site the user allowed read only tells the agent. */
const readOnlyNote = (origin) =>
  `The user gave ${origin} read-only access: you can read its pages but not click, type or change anything there. Don't retry or work around this; ask the user in chat whether to allow read and write.`;

/** Whether a grant covers what a call needs. */
const covers = (grant, need) => grant === 'write' || (grant === 'read' && need === 'read');

/**
 * What to do for a call that needs `need` on an origin with grant `grant`:
 * 'ok' runs it, 'ask' shows the site permission card, 'readOnly' refuses it (the user chose read only).
 */
function decide(grant, need, deniedHere = false) {
  if (covers(grant, need)) return 'ok';
  if (grant === 'read') return 'readOnly';
  return deniedHere ? 'denied' : 'ask';
}

/** Whether a chat's mode opens an ordinary site without a card: Full access, and Auto (as Claude Desktop's Auto does). */
const sitesCovered = (/** @type {string} */ anchor) => anchor === 'full' || anchor === 'auto';

module.exports = { LEVELS, BROWSERS, originOf, siteOf, isLoopback, isBlank, riskView, shown, readOnlyNote, covers, decide, sitesCovered };
