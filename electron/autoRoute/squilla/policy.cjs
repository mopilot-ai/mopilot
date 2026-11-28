// SquillaRouter's model policy, ported from OpenSquilla model_policy.py and controller.py: intent, tier, thinking mode.
'use strict';

const LEXICON = require('./lexicon.json');
const { CODE_BLOCK, FILE_PATH, LOG_BLOCK } = require('./numeric.cjs');
const { pyLen, pyStrip } = require('./text.cjs');

const TIERS = /** @type {const} */ (['C0', 'C1', 'C2', 'C3']);
const INTENTS = /** @type {const} */ (['new_task', 'continue', 'redo']);

// router.runtime.yaml flag_rules and context_rules at the pinned commit; word lists in lexicon.json
const RULES = {
  ...LEXICON.flags,
  debugPatterns: [/Traceback \(most recent/u, /stderr:/u, /FAILED/u],
  longChars: 6000,
  longCodeChars: 1500,
  longLogChars: 1500,
  longFileRefs: 2,
  heavyContextTokens: 2000,
};
const TRIVIAL_ACKS = new Set(LEXICON.trivialAcks);
const ACK_EDGES = new RegExp(`^[${LEXICON.ackEdges}]+|[${LEXICON.ackEdges}]+$`, 'gu');

const matchedChars = (pattern, text) => [...text.matchAll(pattern)].reduce((n, m) => n + pyLen(m[0]), 0);

/**
 * _flags: keyword and size projections of the request text.
 * @param {string} text
 * @param {number} contextTokens
 */
function flagsFor(text, contextTokens) {
  const lowered = text.toLowerCase();
  const any = (words) => words.some((w) => lowered.includes(w.toLowerCase()));
  return {
    high_risk: any(RULES.highRisk),
    debug: any(RULES.debug) || RULES.debugPatterns.some((p) => p.test(text)),
    repo_arch: any(RULES.repoArch),
    strict_format: any(RULES.strictFormat),
    long_context:
      pyLen(text) >= RULES.longChars ||
      matchedChars(CODE_BLOCK, text) >= RULES.longCodeChars ||
      matchedChars(LOG_BLOCK, text) >= RULES.longLogChars ||
      [...text.matchAll(FILE_PATH)].length >= RULES.longFileRefs ||
      contextTokens > RULES.heavyContextTokens,
  };
}

/** controller.compute_margin */
function marginOf(probs) {
  const sorted = [...probs].sort((a, b) => b - a);
  return Math.max(0, sorted[0] - sorted[1]);
}

/** controller.compute_difficulty */
const difficultyOf = (probs) => probs.reduce((n, p, i) => n + i * p, 0);

/**
 * _controller's thinking mode for the final tier (prompt policies are the harness's own and are not ported).
 * @param {string} tier
 * @param {number[] | null} vector normalized tier probabilities when the tier head decided this turn
 * @param {Record<string, boolean>} flags
 * @param {string} text
 */
function thinkingFor(tier, vector, flags, text) {
  const index = TIERS.indexOf(/** @type {any} */ (tier));
  const margin = vector ? marginOf(vector) : 0;
  let thinking;
  if (tier === 'C3') thinking = 'T3';
  else if (index >= 2 && (flags.debug || flags.long_context || flags.high_risk)) thinking = 'T3';
  else if (index <= 0 && margin >= 0.5) thinking = 'T0';
  else if (index <= 1 && margin >= 0.4) thinking = 'T1';
  else thinking = 'T2';
  const ack = pyStrip(text).toLowerCase().replace(ACK_EDGES, '');
  return tier === 'C0' && TRIVIAL_ACKS.has(ack) ? 'T0' : thinking;
}

/** _threshold_intent */
function thresholdIntent(p) {
  if (p.redo >= 0.25 && p.redo > p.new_task) return 'redo';
  return p.new_task >= 0.01 ? 'new_task' : 'continue';
}

const argmax = (probs) => probs.indexOf(Math.max(...probs));

/**
 * decide_model_tier for one turn.
 * @param {{
 *   text: string,
 *   activeTier: string | null,
 *   contextTokens: number,
 *   explicitControl?: 'new_task' | 'redo' | null,
 *   predict: (withIntent: boolean) => Promise<{ intentProbs: Record<string, number> | null, tierProbs: number[] }>,
 * }} o predict runs the tier head, and the intent head too when asked
 */
async function decide({ text, activeTier, contextTokens, explicitControl = null, predict }) {
  const active = activeTier && TIERS.includes(/** @type {any} */ (activeTier)) ? activeTier : null;
  let intent;
  let reason;
  /** @type {Awaited<ReturnType<typeof predict>> | null} */
  let prediction = null;
  if (explicitControl === 'redo' && !active) {
    intent = 'new_task';
    reason = 'redo without an active task starts a new one';
  } else if (explicitControl) {
    intent = explicitControl;
    reason = `explicit ${explicitControl === 'redo' ? 'redo' : 'new task'}`;
  } else if (!active) {
    intent = 'new_task';
    reason = 'no active task';
  } else {
    prediction = await predict(true);
    intent = thresholdIntent(/** @type {Record<string, number>} */ (prediction.intentProbs));
    reason =
      intent === 'new_task'
        ? 'classified as a new task'
        : intent === 'redo'
          ? 'classified as a correction'
          : 'classified as a continuation';
  }
  let tier;
  /** @type {number[] | null} */
  let vector = null;
  if (active && (intent === 'continue' || intent === 'redo')) {
    tier = TIERS[Math.min(TIERS.indexOf(/** @type {any} */ (active)) + (intent === 'redo' ? 1 : 0), 3)];
    reason += intent === 'redo' ? `; one tier above ${active}` : `; keeps ${active}`;
  } else {
    prediction ??= await predict(false);
    const total = prediction.tierProbs.reduce((a, b) => a + b, 0);
    vector = prediction.tierProbs.map((p) => p / total);
    tier = TIERS[argmax(vector)];
    reason += `; tier head chose ${tier}`;
  }
  const flags = flagsFor(text, contextTokens);
  const thinking = thinkingFor(tier, vector, flags, text);
  return {
    intent,
    intentProbs: prediction?.intentProbs ?? null,
    tier,
    tierProbs: prediction?.tierProbs ?? null,
    thinking,
    flags: { debug: flags.debug, high_risk: flags.high_risk, long_context: flags.long_context, strict_format: flags.strict_format },
    difficulty: vector ? difficultyOf(vector) : null,
    margin: vector ? marginOf(vector) : null,
    reason,
  };
}

module.exports = { INTENTS, TIERS, decide, difficultyOf, flagsFor, marginOf, thinkingFor, thresholdIntent };
