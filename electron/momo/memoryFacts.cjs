// What a MoMo memory fact is (#2139, electron/momo/memory.cjs): its shape and validation, where it may come from (a MoMo chat or the user, nothing else), how two facts are the same, and how a search ranks them.
const { prefixUnits } = require('../../shared/textPrefix.mjs');

const CONFIDENCE = new Set(['sure', 'likely']);
/** The longest fact kept. */
const MAX_FACT = 1000;

/**
 * @typedef {'user' | { chatId: string, harness: string }} FactSource the user (typed in the Memory tab), or the MoMo
 *   chat and the harness it ran on
 * @typedef {{ id: string, text: string, source: FactSource, createdAt: number, confidence: 'sure' | 'likely', expiresAt?: number,
 *   origin?: 'extracted', invalidAt?: number, supersededBy?: string }} Fact origin: 'extracted' when MoMo's background pass
 *   wrote it from a chat (MoMo-inferred), absent when a chat or the user saved it; invalidAt: when a newer fact
 *   (supersededBy) replaced it, kept so what was true before can still be told
 */

/**
 * A store failure the tool and IPC layers pass on by its code: bad_args (the caller got an input wrong), unavailable
 * (no encryption on this Mac), unreadable (a document that can't be decrypted), full (too many facts) or changed (an
 * undo of a change whose facts changed again since).
 */
class MemoryError extends Error {
  /** @param {string} message @param {'bad_args' | 'unavailable' | 'unreadable' | 'full' | 'changed'} [code] */
  constructor(message, code = 'bad_args') {
    super(message);
    this.code = code;
  }
}

const UNAVAILABLE = "MoMo's memory is off: this Mac can't encrypt it right now (the Keychain is unavailable).";

/** A source as given: 'user', or a MoMo chat (isMomoChat) with its harness; anything else is refused. */
function sourceOf(/** @type {unknown} */ s, /** @type {(chatId: string) => boolean} */ isMomoChat) {
  if (s === 'user') return 'user';
  const chat = /** @type {any} */ (s);
  if (chat && typeof chat === 'object' && typeof chat.chatId === 'string' && chat.chatId && isMomoChat(chat.chatId) === true)
    return { chatId: chat.chatId, harness: String(chat.harness ?? '') };
  throw new MemoryError('A fact can come only from a MoMo chat or from you, never from another chat');
}

/** @param {unknown} s */
const isSource = (s) =>
  s === 'user' ||
  (!!s &&
    typeof s === 'object' &&
    typeof (/** @type {any} */ (s).chatId) === 'string' &&
    !!(/** @type {any} */ (s).chatId) &&
    typeof (/** @type {any} */ (s).harness) === 'string');

/** The text a fact is compared by: trimmed, inner whitespace collapsed, case ignored. */
const sameText = (/** @type {string} */ t) => t.trim().replace(/\s+/g, ' ').toLowerCase();

/** Chinese, Japanese and Korean letters, written without spaces between words. */
const CJK = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]+/u;

/**
 * The words of a search query or fact, lowercased (letters and digits of any script). A run of Chinese, Japanese or
 * Korean letters has no spaces to split it, so it counts as its overlapping character pairs (one letter alone as itself),
 * and a question that shares part of a fact still finds it.
 */
const words = (/** @type {string} */ t) =>
  (t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).flatMap((w) =>
    w.split(new RegExp(`(${CJK.source})`, 'u')).flatMap((run) => {
      if (!CJK.test(run)) return run ? [run] : [];
      const chars = [...run];
      return chars.length === 1 ? chars : chars.slice(1).map((c, i) => chars[i] + c);
    }),
  );

/** @param {unknown} v @returns {v is Fact} */
function isFact(v) {
  const f = /** @type {any} */ (v);
  return (
    !!f &&
    typeof f === 'object' &&
    typeof f.id === 'string' &&
    !!f.id &&
    typeof f.text === 'string' &&
    !!f.text.trim() &&
    isSource(f.source) &&
    Number.isFinite(f.createdAt) &&
    CONFIDENCE.has(f.confidence) &&
    (f.expiresAt === undefined || Number.isFinite(f.expiresAt)) &&
    (f.origin === undefined || f.origin === 'extracted') &&
    (f.invalidAt === undefined || Number.isFinite(f.invalidAt)) &&
    (f.supersededBy === undefined || (typeof f.supersededBy === 'string' && !!f.supersededBy))
  );
}

/** How long it takes a fact's weight to halve when nothing renews it. */
const HALF_LIFE_DAYS = 180;
const DAY = 24 * 60 * 60 * 1000;

/**
 * How strongly a fact should come back at `now`: what the user said themselves (sure) outweighs what MoMo guessed
 * (likely), and both fade with age, so an old fact gives way to newer ones instead of a hard cap on how many are kept.
 */
function strength(/** @type {Fact} */ f, /** @type {number} */ now) {
  const age = Math.max(0, now - f.createdAt) / DAY;
  return (f.confidence === 'sure' ? 1 : 0.7) * 0.5 ** (age / HALF_LIFE_DAYS);
}

/** A fact's text as given, or a MemoryError. */
function factText(/** @type {unknown} */ text) {
  if (typeof text !== 'string' || !text.trim()) throw new MemoryError('A fact needs its text');
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length > MAX_FACT) throw new MemoryError(`A fact is at most ${MAX_FACT} characters`);
  return t;
}

function confidenceOf(/** @type {unknown} */ c) {
  if (c === undefined) return 'likely';
  if (typeof c !== 'string' || !CONFIDENCE.has(c)) throw new MemoryError("confidence must be 'sure' or 'likely'");
  return /** @type {'sure' | 'likely'} */ (c);
}

/** An expiry as epoch ms, null to clear it, or undefined for none given. */
function expiryOf(/** @type {unknown} */ e) {
  if (e === undefined || e === null) return e;
  if (typeof e !== 'number' || !Number.isFinite(e)) throw new MemoryError('expiresAt must be a time in milliseconds');
  return e;
}

/**
 * The facts that share words with `query`, the best first: by the words matched, each weighted by how rare it is among
 * the facts (a word most facts share, like "is" or "my", counts for little next to "birthday"), then the stronger (sure
 * before likely, newer before older, see strength); all of them, in their order, for a query with no words. At most
 * `limit` (1 to 50; 10 when it is not a number). A fact matches by its search aliases too (`aliasOf`, factAliases.cjs),
 * never shown.
 * @param {Fact[]} facts
 * @param {unknown} query
 * @param {number} limit
 * @param {number} [now]
 * @param {(f: Fact) => string} [aliasOf]
 */
function rankFacts(facts, query, limit, now = Date.now(), aliasOf = () => '') {
  const asked = [...new Set(words(String(query ?? '')))];
  const n = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 10;
  if (!asked.length) return facts.slice(0, n);
  const hay = facts.map((f) => `${f.text}\n${aliasOf(f)}`.toLowerCase());
  // a word's weight: log(1 + facts / facts that have it); one no fact has never matches
  const weight = asked.map((w) => {
    const has = hay.filter((h) => h.includes(w)).length;
    return has ? Math.log(1 + facts.length / has) : 0;
  });
  const scored = facts
    .map((f, i) => ({ f, score: asked.reduce((sum, w, k) => (hay[i].includes(w) ? sum + weight[k] : sum), 0) }))
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score || strength(b.f, now) - strength(a.f, now) || b.f.createdAt - a.f.createdAt);
  return scored.slice(0, n).map((s) => s.f);
}

/** Characters that are about one token each (Chinese, Japanese and Korean); other text is about four characters a token. */
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/** About how many tokens `text` is for a model: each wide character one, the rest a quarter each. */
function estimateTokens(/** @type {string} */ text) {
  const wide = text.match(WIDE)?.length ?? 0;
  return wide + Math.ceil((text.length - wide) / 4);
}

/** `text` cut to about `max` tokens, with an ellipsis when cut ('' when nothing fits); never half an emoji. */
function clipTokens(/** @type {string} */ text, /** @type {number} */ max) {
  if (estimateTokens(text) <= max) return text;
  // the longest prefix that fits with its ellipsis, found by halving (the estimate only grows with the prefix)
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(prefixUnits(text, mid)) + 1 <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo ? `${prefixUnits(text, lo)}…` : '';
}

module.exports = {
  MemoryError,
  UNAVAILABLE,
  MAX_FACT,
  CONFIDENCE,
  sourceOf,
  isSource,
  isFact,
  sameText,
  words,
  factText,
  confidenceOf,
  expiryOf,
  rankFacts,
  strength,
  HALF_LIFE_DAYS,
  estimateTokens,
  clipTokens,
};
