// The sites MoMo may open after a chat read private data (#3655): the exact hosts the user chose "Always allow <host>" for on a navigation's card, kept with the remembered approvals (sentinel.cjs storage), and the check that a navigation's address carries no data (no query, no fragment, no user name, and a short, plain path), since only such an address may open one of them without a card. A site the injected risk check flags (the app passes app/momoSiteRisk.cjs riskyUnasked: high risk, private network, loopback; without one, every site) is never openable this way, and a chat opens listed sites without a card at most MAX_OPENS times (a budget on what even a plain path can carry).
const { normHost } = require('./sentinelRules.cjs');

/** At most this many sites are kept; an add past it is refused (the card then allowed it once). */
const MAX_SITES = 200;
/** A chat opens listed sites without a card at most this many times; then each open asks (once only). */
const MAX_OPENS = 20;
/** A path longer than these, in characters, segments or digits, may carry data (a number, a code, a sentence). */
const MAX_PATH = 48;
const MAX_SEGMENTS = 3;
const MAX_SEGMENT = 32;
const MAX_DIGITS = 4;
/** The characters a plain path segment is made of, once decoded: no spaces, @, =, +, :, %, quotes or other text. */
const PLAIN = /^[A-Za-z0-9._~()-]+$/;
/** Hex, as a hash, token or encoded text is written. */
const HEX = /^[0-9a-f]{12,}$/i;
/** Base64 or base64url text: long, of its alphabet, with letters and digits mixed. */
const BASE64 = (/** @type {string} */ s) => s.length >= 16 && /^[A-Za-z0-9_-]+$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s);
/**
 * A page's file name, the only dotted segment a plain path may end in: any other dot may name a host (an open redirect
 * through a proxy path) or carry text, so no extension that is also a top-level domain (.md, .py, .sh) is here.
 */
const PAGE_EXT = /^[A-Za-z0-9_()~-]+\.(html?|php|aspx?|jsp|pdf)$/i;

/** Why a segment may carry data, or null when it is plain. */
function segmentData(/** @type {string} */ raw, /** @type {boolean} */ last) {
  let s;
  try {
    s = decodeURIComponent(raw);
  } catch {
    return 'encoded';
  }
  if (s !== raw) return 'encoded';
  if (s.length > MAX_SEGMENT || !PLAIN.test(s)) return 'text';
  if (HEX.test(s) || BASE64(s)) return 'encoded';
  if (s.includes('.') && !(last && PAGE_EXT.test(s))) return 'host';
  return null;
}

/**
 * The host a navigation to `url` opens when the address carries no data, else null: an http(s) address (a bare host counts)
 * with no user name, port, query or fragment beyond an empty `?` or `#`, and a short path of plain segments (no encoded or
 * long text, no long digit runs, hex or base64, no dotted names but a page's file name).
 * @param {unknown} url
 * @returns {string | null}
 */
function plainOpenHost(url) {
  const u = plainUrl(url);
  return u && normHost(u.hostname);
}

/**
 * plainOpenHost's host, on a site `risky` doesn't flag: the only navigation an always-allowed site covers. Without a check,
 * every site is risky (it fails closed).
 * @param {unknown} url @param {(href: string) => boolean} [risky]
 */
function cleanOpenHost(url, risky = () => true) {
  const u = plainUrl(url);
  return u && !risky(u.href) ? normHost(u.hostname) : null;
}

/** `url` parsed, when it is an address that carries no data (plainOpenHost); else null. */
function plainUrl(/** @type {unknown} */ url) {
  if (typeof url !== 'string') return null;
  const text = url.trim();
  if (!text || /\s/.test(text)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1].toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https') return null;
  let u;
  try {
    u = new URL(scheme ? text : `https://${text}`);
  } catch {
    return null;
  }
  // an empty `?` or `#` carries nothing (the parser leaves both empty); anything after one may
  if (u.search || u.hash || u.username || u.password || u.port) return null;
  if (u.pathname.length > MAX_PATH || (u.pathname.match(/\d/g)?.length ?? 0) > MAX_DIGITS) return null;
  const segments = u.pathname.split('/').slice(1);
  // a trailing slash leaves one empty segment; any other empty one (`//evil.example`) may hide a host
  if (segments.at(-1) === '') segments.pop();
  if (segments.length > MAX_SEGMENTS || segments.some((s, i) => s === '' || segmentData(s, i === segments.length - 1))) return null;
  return u;
}

/**
 * The host a navigation opens when that is all it sends to and its address carries no data, else null: the only call an
 * always-allowed site covers. Never a change, a recipient, a script's page, an unknown destination or a second host.
 * @param {import('./sentinelRules.cjs').Call} call
 * @param {{ hosts: string[], recipients: string[], unknown: boolean }} dest the call's destinations (destinationsOf)
 */
function siteOpenedBy(call, dest, /** @type {(href: string) => boolean} */ risky) {
  if (typeof call.opens !== 'string' || call.kind !== 'read' || dest.unknown || dest.recipients.length || dest.hosts.length !== 1)
    return null;
  const h = cleanOpenHost(call.opens, risky);
  return h && h === dest.hosts[0] ? h : null;
}

/** The always-allowed sites: exact hosts, normalized, at most MAX_SITES; and each chat's no-card opens (in memory). */
class SiteList {
  /** @type {Set<string>} */
  #hosts = new Set();
  /** @type {Map<string, number>} chat -> no-card opens */
  #opens = new Map();
  /** @type {Map<string, Set<string>>} chat -> the hosts it opened through this list only, with no card (in memory) */
  #bySite = new Map();

  /** @param {{ risky?: (href: string) => boolean }} [o] risky: a site never openable without a card (default: every site) */
  constructor({ risky = () => true } = {}) {
    this.risky = risky;
  }

  /** The listed-or-not host a call opens with a clean address (siteOpenedBy), by this list's risk check. */
  openedBy(
    /** @type {import('./sentinelRules.cjs').Call} */ call,
    /** @type {{ hosts: string[], recipients: string[], unknown: boolean }} */ dest,
  ) {
    return siteOpenedBy(call, dest, this.risky);
  }

  /** Why a call to a listed site still asks, or null: its address may carry data, or the chat spent its no-card opens. */
  reason(
    /** @type {import('./sentinelRules.cjs').Call} */ call,
    /** @type {{ hosts: string[], recipients: string[], unknown: boolean }} */ dest,
  ) {
    if (typeof call.opens !== 'string') return null;
    if (!plainOpenHost(call.opens)) return 'carries-data';
    const host = this.openedBy(call, dest);
    return host && this.#hosts.has(host) && !this.canOpen(call.chatId) ? 'many-opens' : null;
  }

  /** Whether the chat may still open a listed site without a card. */
  canOpen(/** @type {string} */ chatId) {
    return (this.#opens.get(chatId) ?? 0) < MAX_OPENS;
  }

  /**
   * Whether a tainted chat may send to `host` for this call without asking, as far as opened hosts and this list go: a host
   * the chat opened counts, except that a host it opened only through this list (no card, `spend`) counts for acts, not for
   * another navigation, which must still pass the address check until the user answers a card for it in the chat (`confirm`);
   * with `sites`, a listed host the call opens with a clean address within the chat's budget counts too.
   * @param {import('./sentinelRules.cjs').Call} call @param {{ hosts: string[], recipients: string[], unknown: boolean }} dest
   * @param {string} host @param {boolean} opened the chat opened `host` (noteOpened) @param {boolean} sites
   */
  known(call, dest, host, opened, sites) {
    if (opened && (typeof call.opens !== 'string' || !this.#bySite.get(call.chatId)?.has(host))) return true;
    return sites && host === this.openedBy(call, dest) && this.#hosts.has(host) && this.canOpen(call.chatId);
  }

  /** Counts a no-card open of the host the call opens, which is then opened through this list only; true, for a condition. */
  spend(
    /** @type {import('./sentinelRules.cjs').Call} */ call,
    /** @type {{ hosts: string[], recipients: string[], unknown: boolean }} */ dest,
  ) {
    this.#opens.set(call.chatId, (this.#opens.get(call.chatId) ?? 0) + 1);
    const host = /** @type {string} */ (this.openedBy(call, dest));
    this.#bySite.set(call.chatId, (this.#bySite.get(call.chatId) ?? new Set()).add(host));
    return true;
  }

  /** The user answered a card for this navigation: its hosts count as opened for the chat from now on, as after Allow once. */
  confirm(/** @type {import('./sentinelRules.cjs').Call} */ call, /** @type {{ hosts: string[] }} */ dest) {
    if (typeof call.opens === 'string') for (const h of dest.hosts) this.#bySite.get(call.chatId)?.delete(h);
  }

  /** Adds `host`; false when it isn't one or the list is full. */
  add(/** @type {string} */ host) {
    const h = normHost(host);
    if (!h) return false;
    if (this.#hosts.has(h)) return true;
    if (this.#hosts.size >= MAX_SITES) return false;
    this.#hosts.add(h);
    return true;
  }

  /** Removes `host`; whether it was there. */
  remove(/** @type {string} */ host) {
    const h = typeof host === 'string' ? normHost(host) : null;
    return !!h && this.#hosts.delete(h);
  }

  /** Empties the list; how many it held. */
  clear() {
    const n = this.#hosts.size;
    this.#hosts.clear();
    return n;
  }

  /** The hosts, sorted. */
  list() {
    return [...this.#hosts].sort();
  }

  /** Adds the stored hosts, skipping any that isn't one and any in `removed` (the user removed it before storage was read). */
  restore(/** @type {unknown} */ raw, /** @type {Set<string>} */ removed = new Set()) {
    if (!Array.isArray(raw)) return;
    for (const h of raw) if (typeof h === 'string' && h.length <= 253 && !removed.has(normHost(h) ?? '')) this.add(h);
  }

  toJSON() {
    return this.list();
  }
}

module.exports = { cleanOpenHost, plainOpenHost, SiteList, MAX_SITES, MAX_OPENS };
