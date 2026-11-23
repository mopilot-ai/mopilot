// MoPilot's branch prefix for new worktrees, including the legacy default migration shared by main and windows.
export const DEFAULT_BRANCH_PREFIX = 'mopilot/';
export const BRANCH_PREFIX_PREFS_VERSION = 4;

/** Resolve a saved prefix without rewriting custom choices or a choice made after the migration. */
export function branchPrefixOf(prefix, prefsVersion) {
  if (typeof prefix !== 'string' || !prefix) return DEFAULT_BRANCH_PREFIX;
  if (prefix === 'codex/' && !(typeof prefsVersion === 'number' && prefsVersion >= BRANCH_PREFIX_PREFS_VERSION))
    return DEFAULT_BRANCH_PREFIX;
  return prefix;
}
