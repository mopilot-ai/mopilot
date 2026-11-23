// Types for MoPilot's shared branch naming defaults and legacy preference migration.
export const DEFAULT_BRANCH_PREFIX: 'mopilot/';
export const BRANCH_PREFIX_PREFS_VERSION: 4;
export function branchPrefixOf(prefix: unknown, prefsVersion: unknown): string;
