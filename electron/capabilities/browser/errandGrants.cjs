// "Allow messages for this errand" (support chats and the like): after the user's yes on a send-message card, ordinary messages the
// agent sends on that site in that chat go without a card until the errand ends: the user revokes it, the chat is forgotten
// (archived, deleted) or the app restarts (nothing here is saved). Main decides what is ordinary, not the model alone: a message counts
// as committing, and asks every time, unless the agent declared it ordinary AND its text (what the agent typed into the page) shows
// none of: accepting or declining an offer, cancelling or changing an order, a refund, return or replacement, or personal details.
// One table per browser (OriginGrants owns one), so a yes in the built-in browser never covers the user's Chrome.

/** Listeners told when any chat's allowances change (the composer's strip): (browser, chatId) => void. */
const listeners = new Set();

/** Agreeing to, or turning down, what the other side offered. */
const ANSWERS =
  /\b(yes|yeah|yep|sure|ok(?:ay)?|accept(?:ed)?|agree[ds]?|go ahead|proceed|sounds good|deal|i(?:'ll| will) take|please (?:apply|process|do (?:it|that))|decline[ds]?|reject(?:ed)?|no,? thanks?|no thank you|i don'?t want)\b/i;
/** A change to the order itself. */
const ORDER_CHANGE =
  /\b(cancel(?:l?ed|l?ing)?|refund(?:ed)?|replace(?:ment)?|re-?order|exchange|return (?:it|them|the (?:order|item))|change (?:my|the) (?:order|address|delivery|shipping|payment))\b/i;
/** Personal details: an email address, a phone or card number (10 or more digits, separators allowed), a street address. */
const PERSONAL = [
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/i,
  /(?:\+?\d[\s().-]{0,2}){10,}/,
  /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Lane|Ln|Dr|Drive|Way|Court|Ct|Place|Pl)\b/,
];

/** Whether every sentence of `text` is a question (asking about a refund commits to nothing). */
const onlyQuestions = (/** @type {string} */ text) => {
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every((s) => s.endsWith('?'));
};

/**
 * Why sending this message needs the user every time (a short clause for the card), or null when it is ordinary.
 * @param {{ declared?: unknown, text?: unknown }} message `declared`: the agent's message_kind; `text`: what it typed into the page
 */
function commitsWhy({ declared, text }) {
  if (declared !== 'ordinary')
    return declared === 'commits' ? 'the agent says it commits you' : 'the agent did not say what kind of message it is';
  if (typeof text !== 'string' || !text.trim()) return "MoPilot couldn't read what it sends";
  if (PERSONAL.some((re) => re.test(text))) return 'it shares personal details';
  if (ANSWERS.test(text)) return 'it may accept or decline an offer';
  if (ORDER_CHANGE.test(text) && !onlyQuestions(text)) return 'it may change the order';
  return null;
}

/** The site an allowance covers: the registrable domain with its scheme; an IP address, localhost or an unparsable host keeps its origin. */
function errandSite(/** @type {string} */ origin) {
  if (!URL.canParse(origin)) return String(origin);
  const u = new URL(origin);
  // tldts loads with the first allowance, not with main's startup
  const { getDomain } = require('tldts');
  const domain = getDomain(u.hostname, { allowPrivateDomains: true });
  return domain ? `${u.protocol}//${domain}` : u.origin;
}

/**
 * What a send carries for the errand check, and the text the agent typed that a send will carry: typing into the page adds to the
 * tab's outgoing text (fill replaces it); the send takes it with the agent's declared kind (the action's own, else its tool call's).
 * Returns null for anything but a send.
 * @param {{ outgoing?: string }} tab
 * @param {{ kind: string, text?: unknown, value?: unknown, messageKind?: unknown }} action
 * @param {{ kind?: string } | null} sensitive what siteRisk.sensitiveAction() named
 * @param {{ messageKind?: unknown }} ctx the tool call's
 */
function messageOf(tab, action, sensitive, ctx) {
  if (action.kind === 'fill') tab.outgoing = String(action.value ?? '');
  else if (action.kind === 'type') tab.outgoing = `${tab.outgoing ?? ''}${String(action.text ?? '')}`;
  if (sensitive?.kind !== 'send_message') return null;
  const text = tab.outgoing ?? null;
  tab.outgoing = '';
  return { declared: action.messageKind ?? ctx.messageKind, text };
}

/** One browser's errand allowances, in memory: chat id -> site -> since (ms). */
class ErrandGrants {
  /** @param {string} browser 'iab' or 'chrome', which listeners are told */
  constructor(browser = 'iab') {
    this.browser = browser;
    /** @type {Map<string, Map<string, number>>} */
    this.byChat = new Map();
  }

  #changed(/** @type {string} */ chatId) {
    for (const fn of listeners) fn(this.browser, chatId);
  }

  /** Whether ordinary messages from `chatId` on `origin`'s site are allowed for its errand. */
  has(/** @type {string} */ chatId, /** @type {string} */ origin) {
    return !!this.byChat.get(chatId)?.has(errandSite(origin));
  }

  /** The user allowed ordinary messages on `origin`'s site for this chat's errand. */
  add(/** @type {string} */ chatId, /** @type {string} */ origin, now = Date.now()) {
    let sites = this.byChat.get(chatId);
    if (!sites) this.byChat.set(chatId, (sites = new Map()));
    const site = errandSite(origin);
    if (sites.has(site)) return;
    sites.set(site, now);
    this.#changed(chatId);
  }

  /** The user revoked one site's allowance (by the site the list names); true when there was one. */
  revoke(/** @type {string} */ chatId, /** @type {string} */ site) {
    const sites = this.byChat.get(chatId);
    if (!sites?.delete(site)) return false;
    if (!sites.size) this.byChat.delete(chatId);
    this.#changed(chatId);
    return true;
  }

  /** The chat's errand is over (the chat was archived or deleted): every allowance it had ends. */
  end(/** @type {string} */ chatId) {
    if (this.byChat.delete(chatId)) this.#changed(chatId);
  }

  /** What the composer shows: each allowed site with when it began. */
  list(/** @type {string} */ chatId) {
    return [...(this.byChat.get(chatId) ?? [])].map(([site, since]) => ({ site, since, browser: this.browser }));
  }
}

/** Subscribes to every table's changes; returns the unsubscribe. */
function onErrandsChanged(/** @type {(browser: string, chatId: string) => void} */ fn) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

module.exports = { ErrandGrants, commitsWhy, errandSite, messageOf, onErrandsChanged };
