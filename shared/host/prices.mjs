// List prices per model and token kind (plan U5): the table a Host ships, the parser for one an owner sends, and the arithmetic. A number from here is an estimate at list price, never a bill; a model not in the table is unpriced.

/** US dollars per million tokens. `cacheRead` and `cacheWrite` default to the input price when an owner's price lists none (every shipped price lists both). @typedef {{ input: number, output: number, cacheRead?: number, cacheWrite?: number }} Price */

/**
 * Shipped list prices, one model id each: the web gateway's seeded rates (web/db/migrations 0002, 0004, 0005 and 0010,
 * read from Anthropic, OpenAI and DeepSeek on 2026-10-09/10) plus older models chats still name. A model not listed
 * here is unpriced until the owner policy adds it; a newer version never takes an older version's price. These are base
 * rates: the web's long-context tiers and 1-hour cache writes are not applied, so such requests are estimated low.
 * @type {Readonly<Record<string, Price>>}
 */
export const LIST_PRICES = Object.freeze({
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'gpt-6.1-sol': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'gpt-6-astra': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'gpt-6-sol': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'gpt-5.6-sol': { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  'gpt-5.6-terra': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 },
  'gpt-5.4': { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 2.5 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
  'gpt-5.3-codex': { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75 },
  'gpt-5-codex': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0.05 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'deepseek-flash': { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.15 },
});

/** Other ids a listed model is served under: Anthropic's `-0` names, and the model Codex's automatic approval review asks for (web/db/migrations/0007). */
const ALIASES = Object.freeze({
  'claude-opus-4-0': 'claude-opus-4',
  'claude-sonnet-4-0': 'claude-sonnet-4',
  'codex-auto-review': 'gpt-6.1-sol',
});

const MAX_PRICE = 10_000;
const MAX_MODELS = 200;
const num = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_PRICE;

/**
 * An owner's price table, checked whole: model ids, or the start of ids, to prices, each price at least `input` and `output`.
 * @param {unknown} raw @param {(m: string) => Error} bad @returns {Record<string, Price>}
 */
export function parsePrices(raw, bad) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('Prices are a list of models.');
  const entries = Object.entries(raw);
  if (entries.length > MAX_MODELS) throw bad('That is too many models to price.');
  /** @type {Record<string, Price>} */
  const out = {};
  for (const [model, p] of entries) {
    const v = /** @type {any} */ (p);
    if (!/^[\w.:/-]{1,100}$/.test(model) || !v || typeof v !== 'object') throw bad('A price needs a model and its rates.');
    if (!num(v.input) || !num(v.output)) throw bad(`Give ${model} an input and an output price.`);
    for (const k of /** @type {const} */ (['cacheRead', 'cacheWrite']))
      if (v[k] !== undefined && !num(v[k])) throw bad(`${model} has a price this Host cannot read.`);
    out[model] = {
      input: v.input,
      output: v.output,
      ...(v.cacheRead === undefined ? {} : { cacheRead: v.cacheRead }),
      ...(v.cacheWrite === undefined ? {} : { cacheWrite: v.cacheWrite }),
    };
  }
  return out;
}

/** A dated snapshot of a model: `claude-haiku-4-5-20251001`, `gpt-5.4-2026-03-05`. */
const DATED = /^(.+)-(\d{8}|\d{4}-\d{2}-\d{2})$/;
/** Bedrock's form: `us.anthropic.claude-opus-4-5-20251101-v1:0`. */
const BEDROCK = /^(?:[a-z]+\.)?anthropic\.(.+?)(?:-v\d+(?::\d+)?)?$/;

/** The longest model id priced: a longer one is no model (the ledger keeps ids up to 200 characters). */
const MAX_ID = 200;

/** The ids a model may be priced under, its own first: as named, without a provider's wrapping, then the model a dated snapshot is of. @param {string} model */
function idsOf(model) {
  let id = model.replace(/\[[^[\]]*\]$/, ''); // Claude Code's `[1m]` context tag
  id = id.replace(/@(\d{8})$/, '-$1'); // Vertex: `claude-opus-4-5@20251101`
  id = BEDROCK.exec(id)?.[1] ?? id.replace(/^[\w.-]+\//, ''); // Bedrock, or a router's `anthropic/…`
  const base = DATED.exec(id)?.[1];
  return [...new Set([model, id, ...(base ? [base] : [])])];
}

/**
 * The price of a model, or null when it has none. The model's own price comes first: under its id, a dated snapshot of it, or a
 * provider's form of either, the owner's over the shipped one; a shipped price is never another model's, so `claude-opus-4-8` is
 * not `claude-opus-4` and `gpt-5.4-nano` is not `gpt-5.4`. A model with no price of its own takes the owner's longest key its id
 * starts with: the owner prices families on purpose, the shipped table does not.
 * @param {string | null | undefined} model @param {Record<string, Price> | null} [owner]
 */
export function priceFor(model, owner = {}) {
  if (typeof model !== 'string' || !model || model.length > MAX_ID) return null;
  const table = owner ?? {};
  const own = (/** @type {string} */ id) =>
    Object.hasOwn(table, id) ? table[id] : Object.hasOwn(LIST_PRICES, id) ? LIST_PRICES[id] : null;
  const ids = idsOf(model);
  for (const id of ids) {
    const alias = Object.hasOwn(ALIASES, id) ? /** @type {Record<string, string>} */ (ALIASES)[id] : null;
    const price = own(id) ?? (alias ? own(alias) : null);
    if (price) return price;
  }
  const prefix = Object.keys(table)
    .filter((k) => ids.some((id) => id.startsWith(k)))
    .sort((a, b) => b.length - a.length)[0];
  return prefix === undefined ? null : table[prefix];
}

/**
 * One turn's tokens at list price, in dollars; null when the model is unpriced. Cached tokens are counted separately from `inputTokens`.
 * @param {{ inputTokens?: number, outputTokens?: number, cachedReadTokens?: number, cachedWriteTokens?: number }} usage @param {Price | null} price
 */
export function costOf(usage, price) {
  if (!price) return null;
  const n = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const per = (/** @type {number} */ tokens, /** @type {number} */ rate) => (tokens * rate) / 1_000_000;
  return (
    per(n(usage.inputTokens), price.input) +
    per(n(usage.outputTokens), price.output) +
    per(n(usage.cachedReadTokens), price.cacheRead ?? price.input) +
    per(n(usage.cachedWriteTokens), price.cacheWrite ?? price.input)
  );
}
