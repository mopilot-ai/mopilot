// The streaming benchmark's scenarios S1 to S7 (docs/performance/measurement.md): which chats stream, on which harness family, where each is shown, how much history it has, and the token rates and chunk sizes each runs at.

/** @typedef {'codex' | 'claude' | 'acp'} Family */
/**
 * @typedef {{ family: Family, role: 'active' | 'sidebar' | 'window2', switchTo?: Family }} Chat
 *   active: the chat on screen in the focused window; sidebar: listed, not shown; window2: shown in a second, blurred
 *   window; switchTo: the chat starts on `family` and switches to this one before it streams
 * @typedef {{ id: string, variant: string, chats: Chat[], turns: number, bytes: number, toolEveryMs: number }} Plan
 */

export const FAMILIES = /** @type {const} */ (['codex', 'claude', 'acp']);
/** Tokens per second each cell streams at. */
export const RATES = [40, 120];
/** Characters per delta. */
export const CHUNKS = [4, 32];
/** Runs of each cell; the report takes their median. */
export const REPEATS = 3;

const each = (/** @type {(f: Family) => Chat[]} */ chats) => FAMILIES.map((f) => ({ variant: f, chats: chats(f) }));

/** @type {Record<string, { variants: { variant: string, chats: Chat[] }[], turns: number, bytes: number, toolEveryMs?: number }>} */
const DEFS = {
  S1: { variants: each((f) => [{ family: f, role: 'active' }]), turns: 30, bytes: 4096 },
  S2: {
    variants: each((f) => [
      { family: f, role: 'sidebar' },
      { family: f, role: 'active' },
    ]),
    turns: 30,
    bytes: 4096,
  },
  S3: {
    variants: [
      {
        variant: 'mixed',
        chats: [
          { family: 'codex', role: 'sidebar' },
          { family: 'claude', role: 'sidebar' },
          { family: 'acp', role: 'sidebar' },
          { family: 'codex', role: 'active' },
        ],
      },
    ],
    turns: 30,
    bytes: 4096,
  },
  // two chats of mixed families, the active one switched from Codex to Claude Code after its history
  S4: {
    variants: [
      {
        variant: 'switched',
        chats: [
          { family: 'acp', role: 'sidebar' },
          { family: 'codex', switchTo: 'claude', role: 'active' },
        ],
      },
    ],
    turns: 30,
    bytes: 4096,
  },
  S5: { variants: each((f) => [{ family: f, role: 'active' }]), turns: 300, bytes: 20_480 },
  S6: {
    variants: each((f) => [
      { family: f, role: 'active' },
      { family: f, role: 'window2' },
    ]),
    turns: 30,
    bytes: 4096,
  },
  S7: {
    variants: [
      {
        variant: 'acp',
        chats: [
          { family: 'acp', role: 'sidebar' },
          { family: 'acp', role: 'sidebar' },
          { family: 'acp', role: 'sidebar' },
          { family: 'acp', role: 'active' },
        ],
      },
    ],
    turns: 30,
    bytes: 4096,
    toolEveryMs: 200,
  },
};

export const SCENARIO_IDS = Object.keys(DEFS);

/**
 * The plans to run: one per scenario and variant, in order.
 * @param {string[]} ids scenario ids
 * @param {{ turnsScale?: number }} [o] turnsScale: a fraction of the history to build, for a quick run
 * @returns {Plan[]}
 */
export function plans(ids, { turnsScale = 1 } = {}) {
  return ids.flatMap((id) => {
    const d = DEFS[id];
    if (!d) throw new Error(`Unknown scenario: ${id}`);
    return d.variants.map((v) => ({
      id,
      variant: v.variant,
      chats: v.chats,
      turns: Math.max(1, Math.round(d.turns * turnsScale)),
      bytes: d.bytes,
      toolEveryMs: d.toolEveryMs ?? 0,
    }));
  });
}

/**
 * Every cell of a plan: each token rate and chunk size, `repeats` times.
 * @param {{ rates?: number[], chunks?: number[], repeats?: number }} [o]
 */
export function cells({ rates = RATES, chunks = CHUNKS, repeats = REPEATS } = {}) {
  return rates.flatMap((rate) => chunks.flatMap((chunk) => Array.from({ length: repeats }, (_, rep) => ({ rate, chunk, rep }))));
}

/**
 * The order chats are sent their message: the ones in the background first, the active one last, so it is the
 * chat on screen while they all stream.
 * @param {Chat[]} chats
 */
export const sendOrder = (chats) =>
  chats.map((c, i) => ({ c, i })).sort((a, b) => Number(a.c.role === 'active') - Number(b.c.role === 'active'));
