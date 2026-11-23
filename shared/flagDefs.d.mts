// Types for the single flag definition list (shared/flagDefs.mjs).
export type FlagMode = 'kill' | 'toggle';

export interface FlagDef {
  key: string;
  default: boolean;
  owner: string;
  /** The last day the flag may exist (YYYY-MM-DD, UTC), or `permanent`. */
  remove: string;
  mode: FlagMode;
  description: string;
  /** The default in a Windows build, when it differs. */
  win32?: boolean;
}

export const FLAG_DEFS: readonly FlagDef[];
export const FLAG_KEYS: readonly string[];
export function flagDay(now?: number): string;
export function flagExpired(def: Pick<FlagDef, 'remove'>, today: string): boolean;
export function flagDefProblems(defs: readonly Partial<FlagDef>[], today: string): string[];
