// Validates a machine's model catalog and resolves only choices owned by that machine and harness.
/** @typedef {{ id: string, name: string, default: boolean, efforts: string[], defaultEffort: string | null, description?: string, resolvedModel?: string, resolvedId?: string, supportsFastMode?: boolean, supportsAutoMode?: boolean }} MachineModel */
/** @typedef {{ hostId: string, harness: string, model: string, effort: string | null }} HostModelPick */
import { defaultEffort, optionFields } from './agentOptions.mjs';
/** @param {unknown} value @returns {MachineModel[]} */
export function machineModels(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).flatMap((m) => {
    if (typeof m?.id !== 'string' || !m.id || seen.has(m.id)) return [];
    seen.add(m.id);
    const efforts = Array.isArray(m.efforts) ? m.efforts.filter((e) => typeof e === 'string' && e) : [];
    return [
      {
        id: m.id,
        name: typeof m.name === 'string' && m.name ? m.name : m.id,
        default: m.default === true,
        efforts,
        defaultEffort: efforts.includes(m.defaultEffort) ? m.defaultEffort : null,
        // the resolved name, pinned id, fast flag and auto-mode flag: each kept only when valid, else absent ("not reported"); an older Host sends none (#4935)
        ...optionFields(m, efforts),
        // the agent's own line about the model: where Claude Code puts the version ("Opus 5.5 · …"), which the picker names it by
        ...(typeof m.description === 'string' && m.description ? { description: m.description.slice(0, 400) } : {}),
      },
    ];
  });
}

/** The effort a model runs at when none is chosen: the level its Host reports, else the one This Mac's own picker resolves (shared defaultEffort: `high` when offered, else the first). Null for a model without levels. @param {MachineModel} model */
export const modelDefaultEffort = (model) => model.defaultEffort ?? defaultEffort(model.efforts);

/**
 * @param {MachineModel[]} models @param {HostModelPick | null | undefined} pick @param {string} hostId @param {string} harness
 * @param {string | null} [remembered] the effort a new chat of this harness remembers on this Mac (its prefs); used only with no pick of its own, and only when the model offers it
 * @param {{ model?: string, effort?: string | null } | null} [last] what the last chat started on this machine with this harness used (prefs.hostPicks): with no pick of its own, its model while the machine still lists it, and its effort while that model still offers it; a stale one falls back quietly, never "unavailable"
 */
export function hostModelSelection(models, pick, hostId, harness, remembered = null, last = null) {
  const own = pick?.hostId === hostId && pick.harness === harness ? pick : null;
  const lastModel = !own && last?.model ? models.find((m) => m.id === last.model) : undefined;
  const model = (own ? models.find((m) => m.id === own.model) : (lastModel ?? models.find((m) => m.default) ?? models[0])) ?? null;
  const lastEffort = lastModel && last?.effort && lastModel.efforts.includes(last.effort) ? last.effort : null;
  const kept = own ? null : (lastEffort ?? (remembered && model?.efforts.includes(remembered) ? remembered : null));
  const effort =
    model && own?.effort && model.efforts.includes(own.effort) ? own.effort : (kept ?? (model ? modelDefaultEffort(model) : null));
  return { model, effort, unavailable: !!own && (!model || (!!own.effort && !model.efforts.includes(own.effort))) };
}
