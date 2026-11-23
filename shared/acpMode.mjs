// A basic harness's mode wherever its session declares it, shared by main and the window: ACP session modes
// (session/set_mode) or a select config option of category 'mode' (session/set_config_option), as opencode sends.

/**
 * A select option's values, with groups flattened.
 * @param {{ options?: unknown } | null | undefined} o
 * @returns {{ value: unknown, name: string, description?: string | null }[]}
 */
export function selectValues(o) {
  const list = Array.isArray(o?.options) ? o.options : [];
  return list.flatMap((x) => (Array.isArray(x?.options) ? x.options : [x])).filter((x) => x && typeof x === 'object');
}

/**
 * How the session's mode is read and changed, or null when it declares none.
 * @param {{ modes?: any, configOptions?: any } | null | undefined} acp
 * @returns {{ via: 'mode' | 'config', configId: string | null, current: string | null, options: { id: string, name: string, description: string | null }[] } | null}
 */
export function acpModeControl(acp) {
  const modes = acp?.modes;
  if (Array.isArray(modes?.availableModes) && modes.availableModes.length)
    return {
      via: 'mode',
      configId: null,
      current: typeof modes.currentModeId === 'string' ? modes.currentModeId : null,
      options: modes.availableModes.map((m) => ({ id: String(m.id), name: String(m.name ?? m.id), description: m.description ?? null })),
    };
  const opt = (Array.isArray(acp?.configOptions) ? acp.configOptions : []).find((o) => o?.category === 'mode' && o.type === 'select');
  const options = selectValues(opt)
    .filter((v) => typeof v.value === 'string')
    .map((v) => ({ id: /** @type {string} */ (v.value), name: String(v.name ?? v.value), description: v.description ?? null }));
  if (!options.length) return null;
  return { via: 'config', configId: opt.id, current: typeof opt.currentValue === 'string' ? opt.currentValue : null, options };
}

/**
 * The permission row a mode stands for under the quirks' map, or null for one of the agent's own modes. Only the map's
 * own keys count, so a mode id such as "constructor" is never mistaken for a mapped one.
 * @param {Record<string, string> | null | undefined} permissionModes
 * @param {string} id
 * @returns {string | null}
 */
export function permissionOf(permissionModes, id) {
  const p = permissionModes && Object.hasOwn(permissionModes, id) ? permissionModes[id] : null;
  return typeof p === 'string' ? p : null;
}

/**
 * Whether a mode is one of the agent's own (its quirks' agentModes), rather than how much it may do (#1875).
 * @param {readonly string[] | null | undefined} agentModes
 * @param {string} id
 */
export const isAgentMode = (agentModes, id) => Array.isArray(agentModes) && agentModes.includes(id);

/**
 * Whether the session declares a mode that isn't one of the agent's own: what makes permissions usable on a basic
 * harness.
 * @param {{ modes?: any, configOptions?: any } | null | undefined} acp
 * @param {readonly string[] | null | undefined} agentModes
 */
export function acpHasPermissionModes(acp, agentModes) {
  return !!acpModeControl(acp)?.options.some((m) => !isAgentMode(agentModes, m.id));
}

/** The session's current mode id, from either source; null when it has none. */
export function acpCurrentMode(acp) {
  const id = acp?.modes?.currentModeId;
  return typeof id === 'string' ? id : (acpModeControl(acp)?.current ?? null);
}
