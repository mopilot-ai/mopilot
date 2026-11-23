// MoMo's approval card (#2139): the sentinel's askUser, as a momoAction card through the app's one ApprovalBroker, on every harness (the ask comes from the shared trust gate, not the harness). The card carries what the user needs to decide and no more: the action, its source's name, the account, the tool's one-line summary, the destinations and why it asks, and the scopes the rule allows; never the call's arguments or anything it read. The card lives in the chat's SessionState, so it waits with no window open and shows when MoMo's chat opens; the controller says `approval` for it, which is its one "MoMo needs you" notice. The call's signal (its turn stopped or cancelled) withdraws the card, as does MoMo being turned off for the account; an answer that isn't one the card offered counts as none.
const { isRecord } = require('./sentinelRules.cjs');
const { kindOf } = require('./recipients.cjs');

const KIND = 'momoAction';
/** No list on a card is longer, and no text. */
const MAX_LIST = 20;
const MAX_TEXT = 200;
const BLOCKS = new Set(['no-recipients', 'unreadable-recipients']);

/** @typedef {import('./sentinelRules.cjs').Card} Card */
/** @typedef {import('./sentinelRules.cjs').Answer} Answer */
/**
 * What the renderer draws (src/components/momo/MomoActionCard.tsx), as SageApprovalParams.momo.
 * @typedef {{ action: string, tool: string, source: string, account: string, summary: string, hosts: string[],
 *             recipients: string[], recipientItems: { kind: string, label: string }[], recipientCount: number, blocked: string, unknown: boolean, reasons: string[], scopes: string[], denyAlways: boolean, opens?: boolean }} MomoActionParams
 */

const text = (/** @type {unknown} */ v) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '');
const texts = (/** @type {unknown} */ v) =>
  Array.isArray(v)
    ? v
        .filter((s) => typeof s === 'string')
        .slice(0, MAX_LIST)
        .map(text)
    : [];

/**
 * The card's params for the sentinel's card: the source by its name for the user when it has one.
 * @param {Card} card
 * @param {(id: string) => string | undefined} sourceName
 * @returns {MomoActionParams}
 */
function cardParams(card, sourceName) {
  const d = card.destinations;
  return {
    action: card.kind === 'read' ? 'read' : 'change',
    tool: text(card.tool),
    source: text(sourceName(card.source) || card.source),
    account: text(card.account),
    summary: text(card.summary),
    hosts: texts(d.hosts),
    recipients: texts(d.recipients),
    // each recipient with what it is, and how many there are in all (the list is cut at MAX_LIST, the count never)
    recipientItems: texts(d.recipients).map((label) => ({ kind: kindOf(label), label })),
    recipientCount: Array.isArray(d.recipients) ? d.recipients.length : 0,
    // why the card can't be allowed: a change that reaches people with no recipient it can read
    blocked: BLOCKS.has(card.reasons?.[0]) ? card.reasons[0] : '',
    unknown: d.unknown === true,
    reasons: texts(card.reasons),
    scopes: texts(card.scopes),
    denyAlways: card.denyAlways === true,
    ...(card.opens === true ? { opens: true } : {}),
  };
}

/**
 * The sentinel's answer for a window's answer to the card, or null when it is none the card offered.
 * @param {unknown} result { decision: 'allow', scope } or { decision: 'deny', always? }
 * @param {Card} card
 * @returns {Answer | null}
 */
function answerOf(result, card) {
  if (!isRecord(result)) return null;
  const r = /** @type {Record<string, unknown>} */ (result);
  // a paired device's answer names the device, which the audit log's intent entry records
  const by = typeof r.by === 'string' && r.by ? { by: r.by.slice(0, MAX_TEXT) } : {};
  if (r.decision === 'deny') return r.always === true && card.denyAlways ? { allow: false, always: true, ...by } : { allow: false, ...by };
  if (r.decision === 'allow' && typeof r.scope === 'string' && card.scopes.includes(r.scope)) return { allow: true, scope: r.scope, ...by };
  return null;
}

/**
 * @param {object} o
 * @param {() => ({ ask: (chatId: string, kind: string, params: object, o: { signal: AbortSignal | null }) => Promise<unknown> & { id?: string },
 *   answer: (id: string, result: unknown) => boolean }) | null} o.broker the app's ApprovalBroker, once computer use set it up
 * @param {(chatId: string) => string | null | undefined} o.harnessOf the chat's harness now
 * @param {(sourceId: string) => string | undefined} o.sourceName a source's name for the user
 */
function createMomoActionAsk({ broker, harnessOf, sourceName }) {
  /** @type {Map<string, Set<string>>} chat -> the ids of its cards still up */
  const open = new Map();

  /**
   * The sentinel's askUser: resolves with the user's answer, or null when the card went away unanswered.
   * @param {Card} card
   * @param {{ signal?: AbortSignal | null }} [o]
   * @returns {Promise<Answer | null>}
   */
  async function askUser(card, { signal = null } = {}) {
    const b = broker();
    if (!b || signal?.aborted) return null;
    const chatId = card.chatId;
    const pending = b.ask(chatId, KIND, { harness: harnessOf(chatId) ?? '', momo: cardParams(card, sourceName) }, { signal });
    // the broker names every card it puts up
    const id = /** @type {string} */ (pending.id);
    const ids = open.get(chatId) ?? new Set();
    ids.add(id);
    open.set(chatId, ids);
    try {
      return answerOf(await pending, card);
    } finally {
      ids.delete(id);
      if (!ids.size) open.delete(chatId);
    }
  }

  return {
    askUser,
    /** MoMo was turned off for the account: every card still up goes, answering nothing. */
    withdrawAll() {
      const b = broker();
      if (!b) return;
      for (const ids of [...open.values()]) for (const id of [...ids]) b.answer(id, null);
    },
    /** The chat was deleted: its cards still up go, answering nothing. */
    withdrawChat(/** @type {string} */ chatId) {
      const b = broker();
      for (const id of [...(open.get(chatId) ?? [])]) b?.answer(id, null);
    },
    /** How many cards are up for the chat (tests, diagnostics). */
    openFor: (/** @type {string} */ chatId) => open.get(chatId)?.size ?? 0,
  };
}

module.exports = { createMomoActionAsk, cardParams, answerOf, KIND, MAX_LIST, MAX_TEXT };
