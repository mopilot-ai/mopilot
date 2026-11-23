import type { TokenBreakdown } from './contextSnapshot.mjs';

export type AcpUsageReport = { total: TokenBreakdown; last: TokenBreakdown; modelContextWindow: number | null };

export class AcpTokenUsage {
  contextUsed(nid: string, used: number, size: unknown): AcpUsageReport | null;
  turnUsage(nid: string, turnId: string | null | undefined, usage: unknown): AcpUsageReport | null;
  forget(nid: string): void;
}
