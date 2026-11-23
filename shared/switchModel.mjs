// Resolve a switch's explicit model or destination default without carrying the source harness's selection.
const modelId = (value) => (typeof value === 'string' && value.trim() ? value : null);

/** Blank/missing choices use the destination's configured model, or null for its native default. */
export function configuredSwitchModel(kind, requested, prefs = {}) {
  const defaults = { codex: prefs?.model, claude: prefs?.claudeSelection?.model };
  return modelId(requested) ?? modelId(Object.hasOwn(defaults, kind) ? defaults[kind] : null);
}
