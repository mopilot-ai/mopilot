// How a MoMo suggestion is ranked (A7, design 7.5): score = urgency (time to the deadline) x cost of missing (money, a person waiting, a commitment the user made) x confidence x novelty, with a floor for a commitment the user made in their own words that MoMo is sure of; pure functions, no clock but the one passed in. The inputs are kept with the item, so "why did you tell me this?" has an answer, and Hide only lowers the novelty of its kind.

/** How many Hides of one kind are counted, and for how long: a kind the user keeps hiding comes less often, then recovers. */
const MAX_HIDES = 20;
const HIDE_KEEP_MS = 30 * 86_400_000;
/** A commitment in the user's own words, when MoMo is sure of it, never scores below this. */
const COMMITMENT_FLOOR = 0.5;
const H = 3_600_000;

/** What missing it costs, as the model names it. */
const COST = Object.freeze({ none: 0.3, money: 1, person: 0.9, commitment: 0.9 });
const CONFIDENCE = Object.freeze({ low: 0.4, medium: 0.7, high: 0.9, sure: 1 });

/** @typedef {keyof typeof COST} Cost */
/** @typedef {keyof typeof CONFIDENCE} Confidence */
/** @typedef {{ dueAt: number | null, cost: Cost, confidence: Confidence }} ScoreInputs */
/** @typedef {{ urgency: number, cost: number, confidence: number, novelty: number, total: number }} Score */

const isCost = (/** @type {unknown} */ v) => typeof v === 'string' && Object.hasOwn(COST, v);
const isConfidence = (/** @type {unknown} */ v) => typeof v === 'string' && Object.hasOwn(CONFIDENCE, v);

/** How soon it matters: past due or within a day is 1, then less over a week, 0.3 for no date or later. */
function urgencyOf(/** @type {number | null} */ dueAt, /** @type {number} */ now) {
  if (dueAt === null) return 0.3;
  const left = dueAt - now;
  if (left <= 24 * H) return 1;
  if (left <= 72 * H) return 0.8;
  if (left <= 168 * H) return 0.5;
  return 0.3;
}

/** Each Hide of a kind halves what it counts for next time (at least 0.1). */
const noveltyOf = (/** @type {{ n: number } | undefined} */ hides) => Math.max(0.1, 0.5 ** (hides?.n ?? 0));

/**
 * @param {ScoreInputs} inputs
 * @param {{ n: number } | undefined} hides the Hides of this kind still counted
 * @param {number} now
 * @returns {Score}
 */
function scoreOf(inputs, hides, now) {
  const urgency = urgencyOf(inputs.dueAt, now);
  const cost = COST[inputs.cost];
  const confidence = CONFIDENCE[inputs.confidence];
  const novelty = noveltyOf(hides);
  const product = urgency * cost * confidence * novelty;
  const total = inputs.cost === 'commitment' && inputs.confidence === 'sure' ? Math.max(product, COMMITMENT_FLOOR) : product;
  return { urgency, cost, confidence, novelty, total: Math.round(total * 1000) / 1000 };
}

module.exports = { scoreOf, urgencyOf, noveltyOf, isCost, isConfidence, COST, CONFIDENCE, COMMITMENT_FLOOR, MAX_HIDES, HIDE_KEEP_MS };
