import type { UsageWindow } from './model/harness';

export function claudeLiveUsage(info: unknown, at: number): { windows: UsageWindow[]; status: string | null; at: number };
export function claudeLimitResetsAt(info: unknown): number | null;
export function planWindowEntries(info: unknown): [string, { utilization: number; resetsAt?: number }][];
export function planUtilization(info: unknown): number;
export function usageTextLeft(text: string): number | null;
export function usageTextLimit(text: string, printedAt: number): { left: number; resetsAt: number | null } | null;
export const USAGE_READ_FRESH_MS: number;
