// Computer History's policy (#1363): its settings (off by default, the app and site allow lists, retention), allow-list edits that refuse excluded apps and sites, and the gate every activity sample passes before anything is kept: on and not paused, an allowed app that is not excluded, no secure field in focus, and for a browser an allowed site that is not excluded.
const { BROWSERS, anyMatch } = require('../capabilities/contract/desktopPolicy.cjs');
const { appExclusion, siteExclusion, underDomain } = require('./exclusions.cjs');
const { redactTitle, cleanUrl } = require('./redact.cjs');
const { siteOrigin } = require('../../shared/siteOrigin.mjs');

const { BUILT_IN_BROWSER } = require('../../shared/computerHistory.mjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const RETENTION_DAYS = Object.freeze([7, 14, 30, 90]);
const MAX_APPS = 100;
const MAX_SITES = 200;

/**
 * @typedef {{ bundleId: string, name: string }} AllowedApp
 * @typedef {{ enabled: boolean, paused: boolean, apps: AllowedApp[], sites: string[], retentionDays: number, explainerSeen: boolean }} Settings
 * @typedef {{ bundleId: string, app: string, title: string, site?: string, path?: string }} Activity
 */

/** @type {Readonly<Settings>} */
const DEFAULT_SETTINGS = Object.freeze({ enabled: false, paused: false, apps: [], sites: [], retentionDays: 30, explainerSeen: false });

/**
 * A bundle id as macOS writes them (reverse DNS), or the built-in browser's id.
 * @param {unknown} id
 * @returns {id is string}
 */
const validBundleId = (id) => typeof id === 'string' && (id === BUILT_IN_BROWSER.bundleId || /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(id));

/**
 * A site the user typed, as the host the allow list keeps ("https://www.Example.com/x" -> "example.com"), or null.
 * A bare top-level name ("com") is not a site; localhost is.
 * @param {unknown} input
 */
function normalizeSite(input) {
  // siteOrigin refuses what only looks like a host ("mailto:me@example.com" is no site of example.com)
  const origin = siteOrigin(input);
  if (!origin) return null;
  const host = new URL(origin).hostname.replace(/\.$/, '').replace(/^www\./, '');
  if (!host || (!host.includes('.') && host !== 'localhost')) return null;
  return host;
}

/**
 * Settings read from disk, with anything malformed replaced by its default (never by something more permissive)
 * and excluded apps and sites left out.
 * @param {unknown} raw
 * @returns {Settings}
 */
function normalizeSettings(raw) {
  const r = isJsonRecord(raw) ? raw : {};
  const apps = [];
  for (const a of Array.isArray(r.apps) ? r.apps : []) {
    if (!isJsonRecord(a) || !validBundleId(a.bundleId) || apps.some((x) => x.bundleId === a.bundleId)) continue;
    // an app or site excluded since it was allowed is dropped, so Settings never shows it as recorded
    if (a.bundleId !== BUILT_IN_BROWSER.bundleId && appExclusion(a.bundleId)) continue;
    apps.push({ bundleId: a.bundleId, name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : a.bundleId });
  }
  const sites = [];
  for (const s of Array.isArray(r.sites) ? r.sites : []) {
    const host = typeof s === 'string' ? normalizeSite(s) : null;
    if (host && !sites.includes(host) && !siteExclusion(`https://${host}/`)) sites.push(host);
  }
  return {
    enabled: r.enabled === true,
    paused: r.paused === true,
    apps: apps.slice(0, MAX_APPS),
    sites: sites.slice(0, MAX_SITES),
    retentionDays: RETENTION_DAYS.includes(/** @type {number} */ (r.retentionDays))
      ? /** @type {number} */ (r.retentionDays)
      : DEFAULT_SETTINGS.retentionDays,
    explainerSeen: r.explainerSeen === true,
  };
}

/**
 * The settings with `app` allowed, or why it can't be.
 * @param {Settings} settings
 * @param {unknown} app
 * @param {string[]} [userDeny]
 * @returns {{ ok: true, settings: Settings } | { ok: false, reason: string }}
 */
function allowApp(settings, app, userDeny = []) {
  if (!isJsonRecord(app) || !validBundleId(app.bundleId)) return { ok: false, reason: 'Not an app' };
  const why = app.bundleId === BUILT_IN_BROWSER.bundleId ? null : appExclusion(app.bundleId, userDeny);
  if (why) return { ok: false, reason: `Computer History never records this app (${why})` };
  if (settings.apps.some((a) => a.bundleId === app.bundleId)) return { ok: true, settings };
  if (settings.apps.length >= MAX_APPS) return { ok: false, reason: `At most ${MAX_APPS} apps` };
  const name = typeof app.name === 'string' && app.name.trim() ? app.name.trim() : app.bundleId;
  return { ok: true, settings: { ...settings, apps: [...settings.apps, { bundleId: app.bundleId, name }] } };
}

/**
 * The settings with the site allowed, or why it can't be.
 * @param {Settings} settings
 * @param {unknown} input
 * @returns {{ ok: true, settings: Settings, site: string } | { ok: false, reason: string }}
 */
function allowSite(settings, input) {
  const site = normalizeSite(input);
  if (!site) return { ok: false, reason: 'Not a site' };
  const why = siteExclusion(`https://${site}/`);
  if (why) return { ok: false, reason: `Computer History never records this site (${why})` };
  if (settings.sites.includes(site)) return { ok: true, settings, site };
  if (settings.sites.length >= MAX_SITES) return { ok: false, reason: `At most ${MAX_SITES} sites` };
  return { ok: true, settings: { ...settings, sites: [...settings.sites, site] }, site };
}

/** Whether `host` is an allowed site or under one. */
const siteAllowed = (sites, host) => sites.some((s) => underDomain(host, s));

/** Whether an app shows web pages, so a sample of it is kept only for an allowed site. */
const isBrowser = (bundleId) => bundleId === BUILT_IN_BROWSER.bundleId || anyMatch(BROWSERS, bundleId);

/**
 * What of one activity sample may be kept, or why none of it is. Fails closed: a field of the wrong type drops
 * the sample. `source` 'iab' is main's own built-in browser; every other sample comes from the helper.
 * @param {unknown} sample { bundleId, name, title, secure, url?, source? }
 * @param {Settings} settings
 * @param {{ userDeny?: string[] }} [o]
 * @returns {{ activity: Activity } | { drop: string }}
 */
function admitSample(sample, settings, { userDeny = [] } = {}) {
  if (!settings.enabled) return { drop: 'off' };
  if (settings.paused) return { drop: 'paused' };
  if (!isJsonRecord(sample) || !validBundleId(sample.bundleId) || typeof sample.secure !== 'boolean') return { drop: 'invalid' };
  const { bundleId } = sample;
  const iab = bundleId === BUILT_IN_BROWSER.bundleId;
  if (iab !== (sample.source === 'iab')) return { drop: 'invalid' };
  if (sample.secure) return { drop: 'secure field' };
  if (!iab && appExclusion(bundleId, userDeny)) return { drop: 'excluded app' };
  const allowed = settings.apps.find((a) => a.bundleId === bundleId);
  if (!allowed) return { drop: 'app not allowed' };
  const app = typeof sample.name === 'string' && sample.name.trim() ? redactTitle(sample.name) : allowed.name;
  const title = redactTitle(sample.title);
  if (!isBrowser(bundleId)) return { activity: { bundleId, app, title } };
  const url = typeof sample.url === 'string' ? sample.url : null;
  if (!url || siteExclusion(url)) return { drop: url ? 'excluded site' : 'no site' };
  const page = cleanUrl(url);
  if (!page || !siteAllowed(settings.sites, page.site)) return { drop: 'site not allowed' };
  return { activity: { bundleId, app, title, site: page.site, path: page.path } };
}

module.exports = {
  BUILT_IN_BROWSER,
  DEFAULT_SETTINGS,
  RETENTION_DAYS,
  MAX_APPS,
  MAX_SITES,
  normalizeSite,
  normalizeSettings,
  allowApp,
  allowSite,
  siteAllowed,
  isBrowser,
  admitSample,
};
