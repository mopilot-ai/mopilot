// Claude Code's model list (the CLI's probe) as the app's model menu lists it (src/harness/claude/accounts.ts), and the Chrome side panel's (electron/app/chromePanelOptions.cjs).

import { defaultEffort } from './host/agentOptions.mjs';

const ALIASES = new Set(['default', 'opus', 'fable', 'sonnet', 'haiku', 'best', 'opusplan']);
const FAMILIES = ['opus', 'fable', 'sonnet', 'haiku'];

/** The current recommended alias, matched by the CLI's resolved default before the legacy Opus fallback. */
export function claudeDefaultModel(info) {
  const resolved = info.find((m) => m.value === 'default')?.resolvedModel;
  const listed = info.filter((m) => m.value !== 'default');
  return (
    (resolved && listed.find((m) => m.resolvedModel === resolved || m.value === resolved)?.value) ||
    listed.find((m) => m.value === 'opus')?.value ||
    listed[0]?.value ||
    null
  );
}

/**
 * The CLI names a model by its family ("Opus") and puts the version at the head of its description
 * ("Opus 5.5 · Best for…"). Name it with the version, as Claude's own model menu does, and keep the rest as the hint.
 */
function versionedName(displayName, description) {
  const head = description?.split(' · ')[0] ?? '';
  const versioned = head.startsWith(`${displayName} `) && /^\d+(\.\d+)*$/.test(head.slice(displayName.length + 1));
  if (!versioned) return { label: displayName, description };
  return { label: head, description: description.slice(head.length + 3) || undefined };
}

/** A 1M-context variant ("opus[1m]") carries "1M" after its name, as Claude's own model menu shows it, unless the CLI's name already says so. */
function windowSuffixed(id, named) {
  return /\[1m\]$/i.test(id) && !/\b1M\b/i.test(named.label) ? { ...named, label: `${named.label} 1M` } : named;
}

export function claudeModels(info) {
  const listed = info.filter((m) => m.value !== 'default');
  const recommended = claudeDefaultModel(info);
  const base = (m) => m.value.replace(/\[.*\]$/, '');
  // a family the list offers by alias ("opus"): its pinned versions go under "More versions";
  // a model only listed pinned ("claude-fable-5-1[1m]") is the one way to pick it, so it stays in the main list
  const aliased = new Set(listed.map(base).filter((v) => ALIASES.has(v)));
  return listed.map((m) => ({
    id: m.value,
    ...windowSuffixed(m.value, versionedName(m.displayName, m.description)),
    efforts: m.supportedEffortLevels ?? [],
    defaultEffort: defaultEffort(m.supportedEffortLevels),
    fast: !!m.supportsFastMode,
    autoMode: !!m.supportsAutoMode,
    isDefault: m.value === recommended,
    more: !ALIASES.has(base(m)) && FAMILIES.some((f) => aliased.has(f) && base(m).split('-').includes(f)),
    resolved: m.resolvedModel,
  }));
}
