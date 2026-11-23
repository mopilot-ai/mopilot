// The one shared reader of a harness kind's spelling ('codex', 'claude', 'acp:<id>', possibly with a thread
// suffix): which family it is and, for the basic tier, which harness. Exempt from plugin/harness-gate.
/** @typedef {'codex' | 'claude' | 'acp'} HarnessFamily Codex, Claude Code, or any basic harness over ACP */

/**
 * @param {unknown} kind
 * @returns {{ family: HarnessFamily; basic: string | null } | null} null for anything that isn't a harness kind
 */
export function parseKind(kind) {
  const k = String(kind ?? '');
  if (k === 'codex' || k === 'claude') return { family: k, basic: null };
  if (k.startsWith('acp:')) return { family: 'acp', basic: k.slice(4).split(':')[0] };
  return null;
}
