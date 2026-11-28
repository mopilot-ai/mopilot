// Auto model routing's shared vocabulary: the chat's saved mode (meta.config.autoRoute), the menu row that stands for it,
// how a model id ranks by size class and version, and how a router thinking level maps onto a harness's effort scale.

/** The modes a chat can be in: Auto inside its harness, or Auto above all harnesses (which also picks the harness). */
export const AUTO_MODES = Object.freeze(['harness', 'global']);

/** The model menu's Auto row: a renderer-only id, never saved as a model or sent to a harness. */
export const AUTO_MODEL_ID = '@auto';

/** The harness menu's Auto (all harnesses) row: a renderer-only id, never a harness kind. */
export const AUTO_HARNESS_ID = '@auto';

/** The router's tiers, cheapest first, as OpenSquilla's SquillaRouter names them. */
export const TIERS = Object.freeze(['C0', 'C1', 'C2', 'C3']);

/** The effort scale every harness's levels sit on (electron/session/orchestration/childSetup.cjs EFFORT_ORDER). */
export const EFFORT_SCALE = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** The level each router thinking mode asks for (OpenSquilla controller.py _THINKING_MODE_LEVEL; T0 is no thinking). */
const THINKING_EFFORT = Object.freeze({ T0: 'none', T1: 'low', T2: 'medium', T3: 'high' });

/** How much a cost tier weighs price against predicted success when Global Auto scores harnesses. */
export const COST_WEIGHT = Object.freeze({ low: 0.3, medium: 0.12, high: 0.03 });

/**
 * The chat's Auto mode from its saved config, or null when the chat picks its model by hand.
 * @param {{ autoRoute?: unknown } | null | undefined} config
 * @returns {'harness' | 'global' | null}
 */
export function autoModeOf(config) {
  const mode = config?.autoRoute;
  return mode === 'harness' || mode === 'global' ? mode : null;
}

/**
 * The cost tier Global Auto weighs prices with: the saved one, else medium.
 * @param {{ autoRouteCost?: unknown } | null | undefined} prefs
 * @returns {'low' | 'medium' | 'high'}
 */
export function costTierOf(prefs) {
  const tier = prefs?.autoRouteCost;
  return tier === 'low' || tier === 'high' ? tier : 'medium';
}

/**
 * The offered effort nearest the level `thinking` asks for; a tie goes to the higher level, so a turn the router finds
 * hard never gets less thinking than asked. Null when the model offers no levels.
 * @param {string} thinking T0–T3
 * @param {readonly string[]} offered the chosen model's levels
 * @returns {string | null}
 */
export function effortFor(thinking, offered) {
  const levels = (offered ?? []).filter((e) => EFFORT_SCALE.includes(e));
  if (!levels.length) return null;
  const want = EFFORT_SCALE.indexOf(THINKING_EFFORT[thinking] ?? 'medium');
  let best = levels[0];
  for (const level of levels) {
    const d = Math.abs(EFFORT_SCALE.indexOf(level) - want);
    const bestD = Math.abs(EFFORT_SCALE.indexOf(best) - want);
    if (d < bestD || (d === bestD && EFFORT_SCALE.indexOf(level) > EFFORT_SCALE.indexOf(best))) best = level;
  }
  return best;
}

/** Size words, smallest class first; the first match in an id wins, so "flash-lite" is checked before "flash". */
const CLASS_WORDS = [
  [0, ['nano', 'flash-lite', 'lite', 'tiny']],
  [1, ['haiku', 'mini', 'flash', 'small', 'spark', 'air']],
  [3, ['opus', 'max', 'pro', 'ultra', 'large']],
  [4, ['fable']],
  [5, ['mythos']],
];

/**
 * A model's size class: 0 tiny, 1 small, 2 standard (sonnet, a plain GPT), 3 large, 4–5 Claude's largest families.
 * @param {string} id
 */
export function sizeClass(id) {
  const name = String(id ?? '').toLowerCase();
  for (const [rank, words] of CLASS_WORDS) {
    if (words.some((w) => new RegExp(`(?:^|[^a-z])${w}(?:$|[^a-z])`).test(name))) return /** @type {number} */ (rank);
  }
  return 2;
}

/**
 * A model id's version as numbers, newest compares greatest: "claude-opus-4-8" → [4, 8], "gpt-5.4-mini" → [5, 4]. A
 * release date (eight digits) and a bracketed variant ("[1m]") are not versions.
 * @param {string} id
 * @returns {number[]}
 */
export function versionOf(id) {
  const name = String(id ?? '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\d{8}/g, '');
  return (name.match(/\d+/g) ?? []).slice(0, 3).map(Number);
}

/** @param {number[]} a @param {number[]} b */
export function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** A ladder entry: a model id, or the id with the model an alias resolves to ("opus" → "claude-opus-5-5"). */
const entryOf = (/** @type {string | { id: string, resolved?: string | null }} */ m) =>
  typeof m === 'string' ? { id: m, key: m } : { id: m?.id, key: m?.resolved || m?.id };

/**
 * The ladder Auto climbs in a harness: the newest model of each size class, cheapest first, judged by what an alias
 * resolves to; between equals the plain name wins over a variant ("opus" over "opus[1m]" or "opusplan"). A list with
 * one class gives a one-step ladder: Auto then routes only the effort.
 * @param {readonly (string | { id: string, resolved?: string | null })[]} models
 * @returns {string[]}
 */
export function modelLadder(models) {
  /** @type {Map<number, { id: string, key: string }>} */
  const best = new Map();
  for (const m of models ?? []) {
    const e = entryOf(m);
    if (typeof e.id !== 'string' || !e.id) continue;
    const c = sizeClass(e.key);
    const held = best.get(c);
    const d = held ? compareVersions(versionOf(e.key), versionOf(held.key)) : 1;
    if (d > 0 || (d === 0 && held && e.id.length < held.id.length)) best.set(c, e);
  }
  return [...best.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e.id);
}

/**
 * Which ladder step each tier runs on: C0 the cheapest, C3 the strongest, C1 and C2 spread between them (C1 rounds
 * down to the cheaper step, C2 up to the stronger one). A user's own pick for a tier wins when the harness lists it.
 * @param {readonly (string | { id: string, resolved?: string | null })[]} models the harness's models
 * @param {Partial<Record<string, string>> | null | undefined} [override] the user's tier → model table for this harness
 * @returns {Record<'C0' | 'C1' | 'C2' | 'C3', string> | null} null when the harness lists no model
 */
export function tierModels(models, override) {
  const ladder = modelLadder(models);
  if (!ladder.length) return null;
  const last = ladder.length - 1;
  const at = (/** @type {number} */ i) => ladder[Math.max(0, Math.min(last, i))];
  /** @type {Record<'C0' | 'C1' | 'C2' | 'C3', string>} */
  const table = { C0: at(0), C1: at(Math.round(last / 3)), C2: at(Math.ceil((2 * last) / 3)), C3: at(last) };
  // a ladder with a step means the list is there
  const ids = /** @type {readonly (string | { id: string })[]} */ (models).map((m) => entryOf(m).id);
  for (const tier of TIERS) {
    const own = override?.[tier];
    if (typeof own === 'string' && ids.includes(own)) table[/** @type {'C0'} */ (tier)] = own;
  }
  return table;
}
