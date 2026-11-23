// Public display identity for native and host approval envelopes.
import type { HarnessKind } from './model/harness';
export function approvalHarness(request: unknown, fallback?: string | null): HarnessKind | null | undefined;
export function publishApproval<T extends Record<string, unknown>>(
  request: T,
): {
  source: T['source'];
  approval: Omit<T, 'source'> & { sourceHarness?: HarnessKind | null };
};
