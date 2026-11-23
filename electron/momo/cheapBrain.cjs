// The model MoMo's background work (the memory pass, memoryPass.cjs) runs on, per harness family (#2139 P3): Claude Code's
// haiku; on Codex, whose model/list names no tier, the first listed model its own description calls cheap; an ACP agent
// exposes no tiers, so it keeps the brain's own model (degraded, not blocked: the pass's caps still bound it). Each pass
// runs at low effort whatever effort the user picked for MoMo's replies (one its model lacks becomes its default, brainEffort.cjs).
const { byFamily } = require('../session/contract/route.cjs');

/** Words Codex's model/list descriptions use for its cheaper models ("Fast and affordable model for easier tasks"). */
const CHEAP_WORDS = /\b(affordable|efficient|easier tasks|lightweight|mini)\b/i;

/** The first listed (not hidden) Codex model its description calls cheap, or null. @param {unknown} list */
function codexCheapModel(list) {
  for (const m of Array.isArray(list) ? list : [])
    if (m && !m.hidden && typeof m.model === 'string' && CHEAP_WORDS.test(String(m.description ?? ''))) return m.model;
  return null;
}

/**
 * Each family's cheap model; it may read the harness's live model list (`models`, Codex's model/list). null: none.
 * @type {Record<import('../../shared/harnessKind.mjs').HarnessFamily, ((models: () => Promise<any>) => Promise<string | null> | string | null) | null>}
 */
const CHEAP = {
  codex: async (models) => codexCheapModel((await models())?.data),
  claude: () => 'haiku',
  acp: null,
};

/** The effort MoMo's background passes ask for. */
const CHEAP_EFFORT = 'low';

/**
 * `brain` on its harness's cheap model at low effort; as it is where the harness names none or its list can't be read (its own model
 * then: the work still runs, at the brain's price).
 * @param {any} brain
 * @param {() => Promise<any>} [models] the harness's live model list
 */
async function cheapBrain(brain, models = async () => null) {
  const pick = brain ? byFamily(CHEAP, brain.harness) : null;
  /** @type {string | null} */
  let cheap = null;
  try {
    cheap = (await pick?.(models)) ?? null;
  } catch {
    cheap = null;
  }
  if (!brain) return brain;
  return { ...brain, ...(cheap ? { model: cheap } : {}), effort: CHEAP_EFFORT };
}

module.exports = { cheapBrain, codexCheapModel, CHEAP, CHEAP_EFFORT };
