// The approval engine's wire (U1, feature `approvals2`): the clock constants, the card summary, the `attention` state, the `host.pending` answer and the refusal code, parsed the same way by the Host and by every client.

import { prefixUnits } from '../textPrefix.mjs';
/** Declared by a Host that owns waiting cards (host/src/approvals.mjs); an end without it keeps its own timers and derivations. */
export const APPROVALS_FEATURE = 'approvals2';
/** The requests this feature adds: each needs the feature on both ends. */
export const APPROVAL_METHODS = Object.freeze(['host.pending']);
/** The refusal for a second answer to a card (`details: { by, at }`): a normal outcome, not an error to retry. */
export const CARD_ANSWERED = 'card_answered';

/** The clock (D5): remind once, then pause. The owner may raise the pause per machine up to this many minutes. */
export const DEFAULT_REMIND_MINUTES = 10;
export const DEFAULT_PAUSE_MINUTES = 30;
export const MAX_PAUSE_MINUTES = 720;

/** The longest `summary.line` a card carries. */
export const SUMMARY_LINE_MAX = 160;
/** The most cards and chats one `host.pending` answer lists. */
export const PENDING_MAX = 500;

/** Why a card closed (`permissionCancelled.reason`). */
export const CARD_REASONS = Object.freeze(['answered', 'expired', 'stopped', 'turn_ended', 'host_restarted']);
/** What a chat's `attention` can be. */
export const ATTENTION_KINDS = Object.freeze(['approval', 'paused', 'credential']);
/** The tools a card's summary names. */
export const SUMMARY_TOOLS = Object.freeze(['execute', 'edit', 'delete', 'fetch', 'plan', 'question', 'other']);
const CARD_KINDS = Object.freeze(['permission', 'question', 'link']);
const OPTION_KINDS = Object.freeze(['allow', 'deny', 'other']);

/** ACP's tool-call `kind` as the summary's `tool`: a structural signal, never a match on the command text. */
const TOOL_OF_KIND = Object.freeze({
  execute: 'execute',
  edit: 'edit',
  move: 'edit',
  delete: 'delete',
  fetch: 'fetch',
  switch_mode: 'plan',
});

const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (/** @type {unknown} */ v) => Number.isSafeInteger(v) && /** @type {number} */ (v) >= 0;
const text = (/** @type {unknown} */ v) => typeof v === 'string' && v.length > 0 && v.length <= 200;

/** A diff's size, when all three counts are whole numbers. @param {unknown} s */
const statOf = (s) => {
  const o = /** @type {Record<string, any>} */ (s);
  return isObject(s) && count(o.files) && count(o.added) && count(o.removed)
    ? { files: o.files, added: o.added, removed: o.removed }
    : null;
};

/** The one-line summary a client draws a card by. @param {unknown} toolCall the tool call a card carries @param {'permission' | 'question' | 'link'} [cardKind] */
export function summaryOf(toolCall, cardKind = 'permission') {
  const call = isObject(toolCall) ? /** @type {Record<string, any>} */ (toolCall) : {};
  const title = typeof call.title === 'string' ? call.title.replace(/\s+/g, ' ').trim() : '';
  const line = title.length > SUMMARY_LINE_MAX ? `${prefixUnits(title, SUMMARY_LINE_MAX - 1)}…` : title;
  const tool = cardKind === 'question' ? 'question' : /** @type {Record<string, string>} */ (TOOL_OF_KIND[call.kind] ?? 'other');
  const stat = statOf(call.stat);
  return { tool, line, ...(stat ? { stat } : {}) };
}

/** What an answer's option means to a reader of the record: ACP's `allow_*` and `reject_*` kinds. @param {unknown} kind */
export const optionKindOf = (kind) =>
  typeof kind === 'string' && kind.startsWith('allow') ? 'allow' : typeof kind === 'string' && kind.startsWith('reject') ? 'deny' : 'other';

/** A client as the Host knows it (F1): who answered. Anything else is not one. @param {unknown} v @returns {{ fingerprint: string, name: string, kind: string } | null} */
export function principalOf(v) {
  if (!isObject(v)) return null;
  const p = /** @type {Record<string, unknown>} */ (v);
  return text(p.fingerprint) && text(p.name) && text(p.kind)
    ? { fingerprint: /** @type {string} */ (p.fingerprint), name: /** @type {string} */ (p.name), kind: /** @type {string} */ (p.kind) }
    : null;
}

/** A chat's `attention`, read from the state lane or `host.pending`; null for nothing a client could draw. @param {unknown} v */
export function attentionOf(v) {
  if (!isObject(v)) return null;
  const a = /** @type {Record<string, any>} */ (v);
  if (!ATTENTION_KINDS.includes(a.kind) || !Number.isFinite(a.since)) return null;
  if (a.kind === 'approval') {
    const cards = Array.isArray(a.cards) ? a.cards.filter((id) => typeof id === 'string').slice(0, PENDING_MAX) : [];
    return { kind: 'approval', since: a.since, cards };
  }
  if (a.kind === 'paused')
    return {
      kind: 'paused',
      since: a.since,
      reason: 'approval_timeout',
      ...(Number.isSafeInteger(a.pauseMinutes) && a.pauseMinutes >= 1 && a.pauseMinutes <= MAX_PAUSE_MINUTES
        ? { pauseMinutes: a.pauseMinutes }
        : {}),
    };
  return { kind: 'credential', since: a.since };
}

/** One waiting card of `host.pending`; null when it is not one. @param {unknown} v */
export function cardOf(v) {
  if (!isObject(v)) return null;
  const c = /** @type {Record<string, any>} */ (v);
  if (!text(c.chatId) || !text(c.requestId) || !text(c.family) || !CARD_KINDS.includes(c.cardKind) || !Number.isFinite(c.at)) return null;
  if (
    !Number.isSafeInteger(c.epoch) ||
    !isObject(c.summary) ||
    !SUMMARY_TOOLS.includes(c.summary.tool) ||
    typeof c.summary.line !== 'string'
  )
    return null;
  if (c.summary.line.length > SUMMARY_LINE_MAX) return null;
  const options = Array.isArray(c.options)
    ? c.options
        .filter((o) => isObject(o) && text(o.optionId) && typeof o.name === 'string')
        .map((o) => ({ optionId: o.optionId, name: o.name, kind: OPTION_KINDS.includes(o.kind) ? o.kind : 'other' }))
    : [];
  return {
    chatId: c.chatId,
    epoch: c.epoch,
    requestId: c.requestId,
    ...(typeof c.turnId === 'string' ? { turnId: c.turnId } : {}),
    family: c.family,
    cardKind: c.cardKind,
    summary: { tool: c.summary.tool, line: c.summary.line, ...(statOf(c.summary.stat) ? { stat: statOf(c.summary.stat) } : {}) },
    options,
    ...(isObject(c.form) ? { form: c.form } : {}),
    at: c.at,
  };
}

/** The cards a Host reports as no longer waiting, read: which, and who answered (the device's name) when someone did. An older Host reports none. @param {unknown} v */
export function closedOf(v) {
  const r = /** @type {Record<string, any>} */ (isObject(v) ? v : {});
  const list = Array.isArray(r.closed) ? r.closed : [];
  return list
    .slice(0, PENDING_MAX)
    .filter((c) => isObject(c) && text(c.chatId) && text(c.requestId))
    .map((c) => ({
      chatId: /** @type {string} */ (c.chatId),
      requestId: /** @type {string} */ (c.requestId),
      ...(isObject(c.by) && text(c.by.name) ? { by: { name: /** @type {string} */ (c.by.name) } } : {}),
    }));
}

/** The answer of `host.pending`, read: the cards that wait and the chats that need a person. Unreadable entries are dropped, never guessed. @param {unknown} v */
export function pendingOf(v) {
  const r = isObject(v) ? /** @type {Record<string, any>} */ (v) : {};
  const cards = (Array.isArray(r.cards) ? r.cards : [])
    .slice(0, PENDING_MAX)
    .map(cardOf)
    .filter((c) => c !== null);
  const attention = (Array.isArray(r.attention) ? r.attention : [])
    .slice(0, PENDING_MAX)
    .map((a) => {
      const read = attentionOf(a);
      return read && text(a.chatId) ? { chatId: a.chatId, ...read } : null;
    })
    .filter((a) => a !== null);
  return { cards, attention, closed: closedOf(v) };
}

/** The parsers of this feature's requests. `host.pending` takes no params. */
export const approvalParsers = Object.freeze({ 'host.pending': () => ({}) });
