// Shared release rollback protocol types for the web, desktop updater and renderer.
export type RollbackPolicy = { version: string; channel: string; targetVersion: string; requestId: string; enabled: boolean };
export type RollbackIntent = { fromVersion: string; channel: string; requestId: string };
export function rollbackPolicies(value?: unknown): RollbackPolicy[];
export function rollbackSelection<
  R extends { version: string; platform: string; arch: string; rolloutPct: number; sha256?: string; size?: number },
>(
  rows: R[],
  policies: RollbackPolicy[],
  context: { version: string; stagedVersion?: string; channel: string; platform: string; arch: string },
): { row: R; rollback: RollbackIntent } | null;
export function validateRollbackOffer(
  update: { name: string; rollback?: RollbackIntent; sha256?: string; size?: number },
  context: { version: string; stagedVersion?: string; channel: string },
): void;
