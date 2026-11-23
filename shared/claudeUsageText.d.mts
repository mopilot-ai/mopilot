// Shared Claude plan-text parsing contract for desktop and remote account surfaces.
import type { UsageWindow } from './model/harness';
export function parseUsageText(text: string, at?: number): { windows: UsageWindow[]; status: null; at: number } | null;
