// Types for shared/remote/reviewSchema.mjs.
export const DIFF_SCOPES: readonly ['branch', 'uncommitted', 'turn'];
export const MAX_PATH: number;
export const MAX_ROWS: number;
export const DEFAULT_ROWS: number;
export const MAX_READ: number;
export const DEFAULT_READ: number;
export const MIN_READ: number;
export function reviewParsers(h: {
  chatOf: (p: unknown) => string;
  bad: (message: string) => Error;
}): Record<string, (p: Record<string, unknown>) => unknown>;
