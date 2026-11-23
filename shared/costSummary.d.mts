// Types for costSummary.mjs: request ledger lines summed by day, harness, model and payment, priced at list price.
import type { Price } from './host/prices.mjs';

export type UsageRow = {
  day: string;
  harness: string;
  model: string | null;
  pay: string;
  requests: number;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
};
export type PricedRow = UsageRow & { usd: number | null };

export function modelOfLine(line: unknown): string | null;
export function countsUsage(line: unknown): boolean;
export function usageRows(lines: unknown[], day: string | ((line: Record<string, unknown>) => string)): UsageRow[];
export function mergeRows(rows: UsageRow[]): UsageRow[];
export function isUsageRow(v: unknown): v is UsageRow;
export function pricedRows(rows: UsageRow[], owner?: Record<string, Price>): PricedRow[];
export function lineUsd(line: unknown, owner?: Record<string, Price>): number | null;
