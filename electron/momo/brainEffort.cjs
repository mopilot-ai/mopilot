// The effort MoMo's brain runs its model at (#2139): asked for, else the one it had (a model or harness change keeps it),
// checked against the efforts the brain's model offers on its harness (Codex's model/list, Claude Code's probe): one the
// model doesn't offer becomes its default, and a model without effort levels has none. A basic (ACP) harness's thought
// level is its native session's own option, as its model is (the brain chip sets it there), so its brain names none.
const { byFamily } = require('../session/contract/route.cjs');
const { claudeModels } = require('../../shared/claudeModels.mjs');

/** @typedef {{ id: string, efforts: string[], defaultEffort: string | null, isDefault?: boolean }} EffortModel */

/**
 * Each family's models with their efforts, read live; null: the list can't be read now.
 * @type {Record<import('../../shared/harnessKind.mjs').HarnessFamily, ((src: EffortSources, account: string | null) => Promise<EffortModel[] | null>) | null>}
 */
const LISTS = {
  codex: async (src) => {
    const data = (await src.codexModels())?.data;
    if (!Array.isArray(data)) return null;
    return data.map((m) => ({
      id: m.model,
      efforts: (m.supportedReasoningEfforts ?? []).map((e) => e?.reasoningEffort ?? e),
      defaultEffort: m.defaultReasoningEffort ?? null,
      isDefault: !!m.isDefault,
    }));
  },
  claude: async (src, account) => {
    const info = src.claudeProbe(account ?? undefined);
    return info ? claudeModels(info.models ?? []) : null;
  },
  acp: null,
};

/**
 * @typedef {{ codexModels: () => Promise<any>, claudeProbe: (account?: string) => any }} EffortSources
 *   Codex's model/list and Claude Code's last probe for a login
 */

/**
 * The effort a brain asks for: its own when it names one (`effort` given, null included), else the one MoMo had.
 * @param {unknown} input what setBrain was given @param {{ effort?: string | null } | null} before
 */
function askedEffort(input, before) {
  const given = input && typeof input === 'object' && 'effort' in input && input.effort !== undefined;
  if (!given) return before?.effort ?? null;
  const e = /** @type {{ effort: unknown }} */ (input).effort;
  return typeof e === 'string' && e ? e : null;
}

/**
 * `want` on `model`: kept where it offers it, else its default; null where it has no effort levels. An unknown model (its
 * list can't be read) keeps `want`: the harness has the last word.
 * @param {string | null} want @param {EffortModel | null | undefined} model
 */
function effortOn(want, model) {
  if (!model) return want;
  if (!model.efforts.length) return null;
  return want && model.efforts.includes(want) ? want : (model.defaultEffort ?? null);
}

/**
 * The effort `brain` runs at: its own checked against its model's efforts (its harness's default model when it names none).
 * @param {import('./brainModel.cjs').Brain} brain @param {EffortSources | undefined} src
 */
async function brainEffort(brain, src) {
  const list = byFamily(LISTS, brain.harness);
  // a basic harness's brain names none; with nothing to read, the harness has the last word
  if (!list) return null;
  if (!src) return brain.effort;
  /** @type {EffortModel[] | null} */
  let models = null;
  try {
    models = await list(src, brain.account);
  } catch {
    models = null;
  }
  const model = models?.find((m) => (brain.model ? m.id === brain.model : m.isDefault));
  return effortOn(brain.effort, model);
}

/**
 * Main's model lists, read when a brain is checked: Codex's app-server and the last Claude Code probe for a login.
 * @param {any} live main's late-bound services (codex, claudeTurns)
 * @returns {EffortSources}
 */
function effortSources(live) {
  return {
    codexModels: async () => live.codex?.modelList(),
    claudeProbe: (account) => live.claudeTurns?.probeInfo(account) ?? null,
  };
}

module.exports = { askedEffort, effortOn, brainEffort, effortSources, LISTS };
