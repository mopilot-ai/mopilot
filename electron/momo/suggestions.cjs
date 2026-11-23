// MoMo's suggestions (A7, design 7.4 and 7.5): what MoMo noticed and proposes, kept until the user presses Add or Start, Hides it, or it expires (7 days, or when its source changes). A suggestion is { id, title, why, source line, proposed first step, channel, createdAt, expiresAt } plus the inputs of its score. Kept through a tiny storage seam, `{ read, change }`, that the app wires to a sealed file (app/momoSuggestions.cjs) and tests to memory; this module reaches no disk, no Electron and no clock but the ones it is given. At most 3 are added a day, at most 6 are shown, an item is told once and again only when the state of its source changes (key over source, thread or event id and kind), and Hide counts against its kind. Nothing here starts work: only `act` with the user's Start does, and only through the `run` the caller gives it (tests/momoSuggestions.invariant.test.ts).
const crypto = require('node:crypto');
const { scoreOf, isCost, isConfidence, MAX_HIDES, HIDE_KEEP_MS } = require('./suggestionRank.cjs');

const DAY_MS = 86_400_000;
/** How long a suggestion waits in Up next. */
const LIFETIME_MS = 7 * DAY_MS;
/** How long an item that was told is remembered, so it is not told again until its source changes. */
const TOLD_KEEP_MS = 30 * DAY_MS;
/** How long one the user added waits for their Start. */
const ADDED_KEEP_MS = 30 * DAY_MS;
const MAX_NEW_PER_DAY = 3;
const SHOWN = 6;
/** The most kept at once: the lowest scores go first. */
const MAX_LIVE = 20;
const MAX_TOLD = 500;
/** What was done to a suggestion is kept this long, and for at most MAX_DONE of them. */
const DONE_KEEP_MS = 7 * DAY_MS;
const MAX_DONE = 200;
const LIMITS = Object.freeze({ title: 120, why: 240, source: 100, step: 600, from: 40, ref: 120, kind: 40, state: 80, channel: 64 });
/** 'main', or a channel's own id (A2: shared/momoChat.mjs CHANNEL_ID). */
const CHANNEL = /^(?:main|ch_[0-9a-f]{16})$/;

/**
 * @typedef {{ id: string, key: string, title: string, why: string, source: string, step: string, from: string, ref: string, kind: string,
 *   state: string, channel: string, createdAt: number, expiresAt: number, status: 'new' | 'added', at: number,
 *   inputs: import('./suggestionRank.cjs').ScoreInputs }} Suggestion
 *   `state`: how the source stood when MoMo told it (a thread's last message, an event's time); `status`: new, or added by the user
 * @typedef {{ v: 1, items: Suggestion[], told: Record<string, { state: string, at: number }>, hides: Record<string, { n: number, at: number }>,
 *   today: { day: string, n: number }, done: Record<string, { action: 'start' | 'hide', at: number }> }} SuggestionsValue
 * `done`: what the user did to a suggestion that is no longer listed (Start or Hide), kept 7 days, so a card of a brief that names it reads the same after a restart
 * The whole storage seam: sealedFile.cjs's SealedJson fits it, tests use `memoryStorage`.
 * @typedef {{ read: () => SuggestionsValue, change: <R>(fn: (v: SuggestionsValue) => R | Promise<R>) => Promise<R> }} SuggestionsStorage
 */

/** A refusal the callers pass on by its code. */
class SuggestionError extends Error {
  /** @param {string} message @param {'bad_args' | 'capped' | 'duplicate' | 'gone'} code */
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** The day a time falls on in the Mac's zone, as YYYY-MM-DD. */
const dayOf = (/** @type {number} */ ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const keyOf = (/** @type {{ from: string, ref: string, kind: string }} */ s) => `${s.from}|${s.ref}|${s.kind}`.toLowerCase();
const text = (/** @type {unknown} */ v, /** @type {number} */ max) =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const rec = (/** @type {unknown} */ v) => (v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, any>} */ (v) : {});
const when = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One kept item as it must be, or null for what is not one. @param {unknown} raw @returns {Suggestion | null} */
function itemShape(raw) {
  const r = rec(raw);
  const s = {
    id: text(r.id, 64),
    title: text(r.title, LIMITS.title),
    why: text(r.why, LIMITS.why),
    source: text(r.source, LIMITS.source),
    step: text(r.step, LIMITS.step),
    from: text(r.from, LIMITS.from),
    ref: text(r.ref, LIMITS.ref),
    kind: text(r.kind, LIMITS.kind),
    state: text(r.state, LIMITS.state),
    channel: typeof r.channel === 'string' && CHANNEL.test(r.channel) ? r.channel : '',
  };
  const inputs = rec(r.inputs);
  const createdAt = when(r.createdAt);
  const expiresAt = when(r.expiresAt);
  if (!s.id || !s.title || !s.why || !s.source || !s.step || !s.from || !s.ref || !s.kind || !s.channel) return null;
  if (createdAt === null || expiresAt === null || !isCost(inputs.cost) || !isConfidence(inputs.confidence)) return null;
  return {
    ...s,
    key: keyOf(s),
    createdAt,
    expiresAt,
    status: r.status === 'added' ? 'added' : 'new',
    at: when(r.at) ?? createdAt,
    inputs: { dueAt: when(inputs.dueAt), cost: inputs.cost, confidence: inputs.confidence },
  };
}

/**
 * The kept value: the valid live items (not expired, at most MAX_LIVE), what was told and Hidden still counted.
 * @param {unknown} v @param {number} now @returns {SuggestionsValue}
 */
function suggestionsShape(v, now) {
  const r = rec(v);
  const seen = new Set();
  const items = (Array.isArray(r.items) ? r.items : [])
    .map(itemShape)
    .filter((/** @type {Suggestion | null} */ s) => s !== null && s.expiresAt > now && !seen.has(s.id) && !!seen.add(s.id))
    .slice(0, MAX_LIVE);
  const told = Object.entries(rec(r.told))
    .filter(([, t]) => typeof rec(t).state === 'string' && when(rec(t).at) !== null && now - rec(t).at < TOLD_KEEP_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_TOLD)
    .map(([k, t]) => [k, { state: String(t.state).slice(0, LIMITS.state), at: Number(t.at) }]);
  const hides = Object.entries(rec(r.hides))
    .filter(([, h]) => when(rec(h).at) !== null && Number.isInteger(rec(h).n) && rec(h).n > 0 && now - rec(h).at < HIDE_KEEP_MS)
    .map(([k, h]) => [k, { n: Math.min(h.n, MAX_HIDES), at: Number(h.at) }]);
  const done = Object.entries(rec(r.done))
    .filter(
      ([id, d]) =>
        id.length <= 64 &&
        (rec(d).action === 'start' || rec(d).action === 'hide') &&
        when(rec(d).at) !== null &&
        now - rec(d).at < DONE_KEEP_MS,
    )
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_DONE)
    .map(([k, d]) => [k, { action: d.action, at: Number(d.at) }]);
  const today = rec(r.today);
  return {
    v: 1,
    items: /** @type {Suggestion[]} */ (items),
    told: Object.fromEntries(told),
    hides: Object.fromEntries(hides),
    done: Object.fromEntries(done),
    today: typeof today.day === 'string' && Number.isInteger(today.n) && today.n >= 0 ? { day: today.day, n: today.n } : { day: '', n: 0 },
  };
}

/** A storage that keeps the value in memory (tests, the dev host's stand-in). @returns {SuggestionsStorage} */
function memoryStorage(/** @type {{ now?: () => number }} */ { now = Date.now } = {}) {
  let value = suggestionsShape(null, now());
  return {
    read: () => suggestionsShape(value, now()),
    change: async (fn) => {
      const next = suggestionsShape(value, now());
      const out = await fn(next);
      value = suggestionsShape(next, now());
      return out;
    },
  };
}

/**
 * What a model may say about one suggestion, checked: every text field is needed, the model's own words are clipped, a channel is
 * 'main' or an id, and the inputs of the score are the ones the ranking knows.
 * @param {unknown} given @returns {Omit<Suggestion, 'id' | 'createdAt' | 'expiresAt' | 'at' | 'status' | 'key'>}
 */
function parseNew(given) {
  const g = rec(given);
  const s = {
    title: text(g.title, LIMITS.title),
    why: text(g.why, LIMITS.why),
    source: text(g.source, LIMITS.source),
    step: text(g.step, LIMITS.step),
    from: text(g.from, LIMITS.from),
    ref: text(g.ref, LIMITS.ref),
    kind: text(g.kind, LIMITS.kind),
    state: text(g.state, LIMITS.state),
    channel: g.channel === undefined ? 'main' : typeof g.channel === 'string' && CHANNEL.test(g.channel) ? g.channel : '',
  };
  for (const field of /** @type {const} */ (['title', 'why', 'source', 'step', 'from', 'ref', 'kind', 'channel']))
    if (!s[field]) throw new SuggestionError(`A suggestion needs its ${field === 'from' ? 'source name (from)' : field}.`, 'bad_args');
  if (typeof g.why === 'string' && g.why.trim().length > LIMITS.why)
    throw new SuggestionError(`"why" is at most ${LIMITS.why} characters.`, 'bad_args');
  const cost = g.cost ?? 'none';
  const confidence = g.confidence ?? 'medium';
  if (!isCost(cost)) throw new SuggestionError('"cost" is none, money, person or commitment.', 'bad_args');
  if (!isConfidence(confidence)) throw new SuggestionError('"confidence" is low, medium, high or sure.', 'bad_args');
  const dueAt = g.dueAt === undefined || g.dueAt === null ? null : when(g.dueAt);
  if (g.dueAt !== undefined && g.dueAt !== null && dueAt === null)
    throw new SuggestionError('"dueAt" is a time in milliseconds.', 'bad_args');
  return { ...s, inputs: { dueAt, cost, confidence } };
}

/**
 * @param {{ storage: SuggestionsStorage, now?: () => number, newId?: () => string }} o
 */
function createSuggestions({ storage, now = Date.now, newId = () => crypto.randomUUID() }) {
  /** The live items with their scores, the best first. */
  const ranked = (/** @type {SuggestionsValue} */ v) =>
    v.items
      .map((s) => ({ ...s, score: scoreOf(s.inputs, v.hides[s.kind], now()) }))
      .sort((a, b) => b.score.total - a.score.total || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const gone = () => new SuggestionError('That suggestion is gone.', 'gone');
  return {
    /** The live suggestions, the best first; the first SHOWN `new` ones are what the panel shows before "Show more". */
    list() {
      const v = storage.read();
      return { suggestions: ranked(v), shown: SHOWN, done: Object.fromEntries(Object.entries(v.done).map(([id, d]) => [id, d.action])) };
    },

    /**
     * MoMo adds one (its momo_suggest tool). Refused when it is told already and its source has not changed (`duplicate`) and
     * once MAX_NEW_PER_DAY were added today (`capped`); when the source changed, the older one is replaced by this one.
     * @param {unknown} given
     */
    async add(given) {
      const parsed = parseNew(given);
      const key = keyOf(parsed);
      return storage.change((v) => {
        const t = now();
        const told = v.told[key];
        if (told && told.state === parsed.state)
          throw new SuggestionError('That was already suggested and nothing about it changed, so it is not suggested again.', 'duplicate');
        const today = dayOf(t);
        if (v.today.day !== today) v.today = { day: today, n: 0 };
        if (v.today.n >= MAX_NEW_PER_DAY)
          throw new SuggestionError(`At most ${MAX_NEW_PER_DAY} new suggestions a day: keep this one for tomorrow.`, 'capped');
        const item = { ...parsed, id: newId(), key, createdAt: t, expiresAt: t + LIFETIME_MS, status: /** @type {const} */ ('new'), at: t };
        // the source changed: the earlier one is out of date
        v.items = v.items.filter((s) => s.key !== key);
        v.items.push(item);
        v.today.n += 1;
        v.told[key] = { state: parsed.state, at: t };
        const keep = new Set(
          ranked(v)
            .slice(0, MAX_LIVE)
            .map((s) => s.id),
        );
        v.items = v.items.filter((s) => keep.has(s.id));
        return item;
      });
    },

    /**
     * The user's own act on one: add (keep it as a task of theirs), hide (gone; its kind counts less) or start. Start takes it out
     * and calls `run(item)`; when that throws the suggestion is put back and the error goes on, so nothing is dropped.
     * @param {unknown} id @param {unknown} action @param {(item: Suggestion) => Promise<unknown>} [run]
     * @returns {Promise<{ id: string, action: 'add' | 'hide' | 'start', item: Suggestion }>}
     */
    async act(id, action, run) {
      if (typeof id !== 'string' || !id) throw new SuggestionError('Say which suggestion.', 'bad_args');
      if (action !== 'start' && action !== 'hide' && action !== 'add') throw new SuggestionError('Pick Add, Start or Hide.', 'bad_args');
      const taken = await storage.change((v) => {
        const at = v.items.findIndex((s) => s.id === id);
        if (at < 0) throw gone();
        const item = v.items[at];
        if (action === 'add') {
          // a task of the user's own now: it waits for their Start for a month, not a week
          v.items[at] = { ...item, status: 'added', at: now(), expiresAt: Math.max(item.expiresAt, now() + ADDED_KEEP_MS) };
        } else {
          v.items.splice(at, 1);
          v.done[id] = { action, at: now() };
          if (action === 'hide') v.hides[item.kind] = { n: Math.min((v.hides[item.kind]?.n ?? 0) + 1, MAX_HIDES), at: now() };
        }
        return { item, at };
      });
      if (action === 'start') {
        try {
          await run?.(taken.item);
        } catch (error) {
          await storage.change((v) => {
            if (!v.items.some((s) => s.id === id)) v.items.splice(Math.min(taken.at, v.items.length), 0, taken.item);
            delete v.done[id];
          });
          throw error;
        }
      }
      return { id, action, item: taken.item };
    },
  };
}

module.exports = {
  createSuggestions,
  suggestionsShape,
  memoryStorage,
  parseNew,
  SuggestionError,
  SHOWN,
  MAX_NEW_PER_DAY,
  MAX_LIVE,
  LIFETIME_MS,
  TOLD_KEEP_MS,
  LIMITS,
  CHANNEL,
};
