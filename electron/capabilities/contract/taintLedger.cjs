// Which origins tainted a chat's turn (G3, #3571): a screened tool result whose text tried to instruct the agent taints @host-portable
// the turn of its chat, by the origin it came from (a site, `app:<bundle id>` for an app on the Mac). Keyed by the chat,
// never the segment, so a harness switch mid-turn keeps the taint; the turn's end (main's turn ledger) clears it. After
// taint, the browser's one confirmation path (browser/originAction.cjs) asks before a send, a delete, a payment or
// upload, a submit that leaves the page's origin or lands on a tainting one, page JavaScript, and a navigation whose
// address carries data the turn read from another origin, in every permission mode, Full access included.
const { prefixUnits } = require('../../../shared/textPrefix.mjs');

const { findInjections } = require('./injectionHeuristics.cjs');
const { messageOf, noteIgnored } = require('../../ignored.cjs');

/** The most flagged quotes one turn keeps (the card shows the latest), and how much of each. */
const MAX_QUOTES = 8;
const QUOTE_CHARS = 160;
/** The most distinct read tokens one turn keeps (the oldest go first), and the most origins. */
const MAX_TOKENS = 4000;
const MAX_ORIGINS = 32;

/**
 * The tokens of read text that identify data rather than words: e-mail addresses, numbers of four digits or more, and
 * codes mixing letters and digits ("TRK1234ab", "SO-48213"); lowercased.
 * @param {string} text
 * @returns {string[]}
 */
function dataTokens(text) {
  const s = String(text ?? '');
  const out = new Set();
  for (const m of s.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) out.add(m[0].toLowerCase());
  for (const m of s.matchAll(/[A-Za-z0-9][A-Za-z0-9_-]{3,}/g)) {
    const t = m[0];
    if (/\d{4,}/.test(t) || (/\d/.test(t) && /[A-Za-z]/.test(t) && t.length >= 6)) out.add(t.toLowerCase());
  }
  return [...out];
}

/**
 * The tokens of a URL's path, query and fragment (decoded), where data a page wants sent would ride. The host is left
 * out: it is where the navigation goes, not what it carries.
 * @param {string} url
 */
function urlTokens(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return [];
  }
  let rest = `${u.pathname} ${u.search} ${u.hash}`.replace(/\+/g, ' ');
  try {
    rest = decodeURIComponent(rest);
  } catch (error) {
    // a malformed escape: the raw text still carries its plain tokens
    noteIgnored("decode a navigation address's escapes", error);
  }
  return dataTokens(rest);
}

const originOfUrl = (/** @type {string} */ url) => {
  try {
    const u = new URL(String(url));
    return u.origin === 'null' ? '' : u.origin;
  } catch {
    return '';
  }
};

const oneLine = (/** @type {string} */ s, /** @type {number} */ n) => {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${prefixUnits(flat, n - 1)}…` : flat;
};

/** @typedef {{ origins: Set<string>, quotes: Array<{ origin: string, text: string }>, reads: Map<string, Set<string>>, order: Array<[Set<string>, string]> }} Turn */

class TaintLedger {
  constructor() {
    /** @type {Map<string, Turn>} chat -> its current turn's record */
    this.turns = new Map();
  }

  /** @param {string} chatId */
  #turn(chatId) {
    let t = this.turns.get(chatId);
    if (!t) this.turns.set(chatId, (t = { origins: new Set(), quotes: [], reads: new Map(), order: [] }));
    return t;
  }

  /**
   * A screened result of the chat's turn: the text read from `origin` (its data tokens are kept for the navigation
   * check), and the spans flagged in it, which taint the turn.
   * @param {string} chatId
   * @param {{ origin: string, text?: string, flagged?: string[] }} read
   */
  record(chatId, { origin, text = '', flagged = [] }) {
    if (!chatId || !origin) return;
    const t = this.#turn(chatId);
    let seen = t.reads.get(origin);
    if (!seen && t.reads.size < MAX_ORIGINS) t.reads.set(origin, (seen = new Set()));
    if (seen)
      for (const token of dataTokens(text)) {
        if (seen.has(token)) continue;
        seen.add(token);
        t.order.push([seen, token]);
        // full: the oldest token goes, so data read late in a long turn is still checked
        if (t.order.length > MAX_TOKENS) {
          const [set, old] = /** @type {[Set<string>, string]} */ (t.order.shift());
          set.delete(old);
        }
      }
    if (!flagged.length) return;
    t.origins.add(origin);
    for (const q of flagged) t.quotes.push({ origin, text: oneLine(q, QUOTE_CHARS) });
    if (t.quotes.length > MAX_QUOTES) t.quotes.splice(0, t.quotes.length - MAX_QUOTES);
  }

  /**
   * A confirmation card's summary in the chat's turn: as it was, or, once the turn is tainted, with the flagged text
   * quoted the way the browser's cards quote it (computer use's irreversible-action cards, which ask in every mode).
   * @param {string} chatId @param {string} summary
   */
  cardSummary(chatId, summary) {
    const card = this.check(chatId, { kind: 'sensitive' });
    return card ? `${prefixUnits(String(summary), 120)} · ${card.why}: ${card.quote}` : summary;
  }

  /**
   * Screens text read outside the Registry (the Codex Browser plugin's own reads, browser/iabBackend/readTaint.cjs) and
   * records it: a flag taints the turn, and a detector that throws taints it as not screened (never clean).
   * @param {string} chatId @param {{ origin: string, text: string }} read
   */
  screenRead(chatId, { origin, text }) {
    /** @type {string[]} */
    let flagged;
    try {
      flagged = findInjections(text).map(({ start, end }) => text.slice(start, end));
    } catch (error) {
      flagged = [`(not screened: ${prefixUnits(messageOf(error), 120)})`];
    }
    this.record(chatId, { origin, text, flagged });
  }

  /** The origins that tainted the chat's current turn (empty: none). @param {string} chatId @returns {string[]} */
  taintedBy(chatId) {
    return [...(this.turns.get(chatId)?.origins ?? [])];
  }

  /**
   * Whether an action needs the card because the turn is tainted, and what it quotes; null when it doesn't.
   * `kind`: 'sensitive' (a send, delete, payment or transfer), 'upload', 'submit' (a form submit; `to` its destination
   * page), 'script' (page JavaScript), 'navigate' (`to` the address).
   * @param {string} chatId
   * @param {{ kind: 'sensitive' | 'upload' | 'submit' | 'script' | 'navigate', page?: string, to?: string }} action
   * @returns {{ origins: string[], quote: string, why: string } | null}
   */
  check(chatId, { kind, page = '', to = '' }) {
    const t = this.turns.get(chatId);
    if (!t || !t.origins.size) return null;
    const last = t.quotes[t.quotes.length - 1];
    const card = (/** @type {string} */ why) => ({
      origins: [...t.origins],
      quote: `${last.origin}: "${last.text}"`,
      why,
    });
    if (kind === 'sensitive' || kind === 'upload') return card('text read in this turn tried to instruct the agent');
    if (kind === 'script') return card('page JavaScript can send data anywhere, and text read in this turn tried to instruct the agent');
    const from = originOfUrl(page);
    const dest = originOfUrl(to || page);
    if (kind === 'submit') {
      if (dest && (dest !== from || t.origins.has(dest)))
        return card(`this submits to ${dest} after text read in this turn tried to instruct the agent`);
      return null;
    }
    // a navigation: does its address carry data the turn read from another origin than the one it goes to?
    const own = t.reads.get(dest);
    const carried = urlTokens(to).find((token) => !own?.has(token) && [...t.reads].some(([o, set]) => o !== dest && set.has(token)));
    return carried ? card(`the address carries "${oneLine(carried, 40)}", read from another site in this turn`) : null;
  }

  /** The chat's turn ended (main's turn ledger, every harness): its taint and reads go. @param {string} chatId */
  turnEnded(chatId) {
    this.turns.delete(chatId);
  }
}

module.exports = { TaintLedger, dataTokens, urlTokens, MAX_QUOTES, MAX_TOKENS, MAX_ORIGINS };
