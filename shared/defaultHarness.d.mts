export type HarnessKindValue = 'codex' | 'claude' | `acp:${string}`;
export function isHarnessKind(v: unknown): v is HarnessKindValue;
export const RETIRED_DEFAULT_HARNESS_PREFS: readonly string[];
export function defaultHarnessPatch(prefs: unknown): { set: { defaultHarness?: HarnessKindValue }; unset: string[] } | null;
