// The one shape of an agent's model options a Host reports and the Mac and phone read (#4935): the resolved display name, the pinned id, the default effort (one function) and the fast-mode flag, each absent when unknown.

/** The longest resolved display name a Host may send. */
export const RESOLVED_MAX = 60;
/** The longest pinned model id a Host may send. */
export const RESOLVED_ID_MAX = 120;

/**
 * The effort an agent runs at when none is chosen, for a model that takes `efforts`: the level the agent itself names when it is one of them, else `high` when the model has it, else its first level; null for a model without levels.
 * This Mac's menu and the Host's report both use this function, so they agree.
 * @param {unknown} efforts
 * @param {unknown} [preferred] the level the agent reports as its own default
 * @returns {string | null}
 */
export function defaultEffort(efforts, preferred) {
  const levels = Array.isArray(efforts) ? efforts.filter((e) => typeof e === 'string' && e) : [];
  if (typeof preferred === 'string' && levels.includes(preferred)) return preferred;
  return levels.includes('high') ? 'high' : (levels[0] ?? null);
}

const FAMILY_VERSION = /^((?:Opus|Sonnet|Haiku|Fable)\s+\d+(?:\.\d+)*)(?![\w.])/i;
const CURRENTLY = /\(currently ([^)]+?)\)/i;
const PINNED = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/i;
const cap = (/** @type {string} */ s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/**
 * The display name with its version of a Claude Code model, from what the CLI reports: the version at the head of its description ("Opus 5.5 · Best for…"), or the one a default entry names ("…(currently Opus 5.5)"), else the pinned id behind it ("claude-opus-5-5"). Null when none says a version: an alias is never a name.
 * @param {{ value?: unknown, description?: unknown, resolvedId?: unknown }} m
 * @returns {string | null}
 */
export function claudeResolvedName(m) {
  const text = typeof m.description === 'string' ? m.description.trim() : '';
  const head = text.split(' · ')[0];
  const named = FAMILY_VERSION.exec(CURRENTLY.exec(head)?.[1].trim() ?? head)?.[1];
  const pinned = typeof m.resolvedId === 'string' ? PINNED.exec(m.resolvedId) : null;
  const name = named ?? (pinned ? `${cap(pinned[1])} ${pinned[2]}${pinned[3] ? `.${pinned[3]}` : ''}` : null);
  if (!name) return null;
  return typeof m.value === 'string' && /\[1m\]$/i.test(m.value) && !/\b1M\b/i.test(name) ? `${name} 1M` : name;
}

/**
 * The option fields of one model entry as a Host may send them, each kept only when valid: `resolvedModel` (a name, at most 60 characters, never the entry's own id or a bare alias), `resolvedId`, `defaultEffort` (one of `efforts`), `supportsFastMode` and `supportsAutoMode` (booleans; the latter says whether the model can run under "Approve for me").
 * @param {{ id: string, resolvedModel?: unknown, resolvedId?: unknown, defaultEffort?: unknown, supportsFastMode?: unknown, supportsAutoMode?: unknown }} m
 * @param {string[]} efforts
 * @returns {{ resolvedModel?: string, resolvedId?: string, defaultEffort?: string, supportsFastMode?: boolean, supportsAutoMode?: boolean }}
 */
export function optionFields(m, efforts) {
  const name = typeof m.resolvedModel === 'string' ? m.resolvedModel.trim() : '';
  const aliased = name === m.id || (name.toLowerCase() === m.id.toLowerCase() && !/\d/.test(name));
  const id = typeof m.resolvedId === 'string' ? m.resolvedId.trim() : '';
  return {
    ...(name && name.length <= RESOLVED_MAX && !aliased ? { resolvedModel: name } : {}),
    ...(id && id.length <= RESOLVED_ID_MAX ? { resolvedId: id } : {}),
    ...(typeof m.defaultEffort === 'string' && efforts.includes(m.defaultEffort) ? { defaultEffort: m.defaultEffort } : {}),
    ...(typeof m.supportsFastMode === 'boolean' ? { supportsFastMode: m.supportsFastMode } : {}),
    ...(typeof m.supportsAutoMode === 'boolean' ? { supportsAutoMode: m.supportsAutoMode } : {}),
  };
}
