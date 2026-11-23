// Bind reported context to the chat's current native session, shared by Status and the floating context card.
import type { AppState } from '../store/state';
import { acpHarnessOf, type Segment } from '../harness/types';
import { currentFamily } from '../harness/family';
import { currentNativeId } from '../harness/ownership';
import { contextShare, contextTokens } from '../lib/contextFormat';

/** Native ids can repeat across harnesses; structured owner keys preserve every boundary. */
export function contextUsageKey(segments: Segment[] | undefined, chatId: string): string {
  const nativeId = currentNativeId(segments, chatId);
  const basic = acpHarnessOf(nativeId);
  const harness = segments?.at(-1)?.harness ?? (basic ? `acp:${basic}` : currentFamily(segments, chatId));
  return JSON.stringify([chatId, harness, nativeId]);
}

/** Reports carry the actual sender before canonical-chat mapping; a current owner cannot confer provenance. */
export function contextReportOwner(chatId: string, source: unknown): string | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const { harness, nativeId } = source as Record<string, unknown>;
  return typeof harness === 'string' && harness.length > 0 && typeof nativeId === 'string' && nativeId.length > 0
    ? JSON.stringify([chatId, harness, nativeId])
    : undefined;
}

/** How full a chat's context window is: what it holds now and the window, both reported. */
export type ContextReading = { used: number; window: number };

/** Accept only a real bounded reading; an unavailable value must never look like zero use. */
export function contextReading(used: unknown, window: unknown): ContextReading | null {
  return typeof used === 'number' &&
    Number.isFinite(used) &&
    used >= 0 &&
    typeof window === 'number' &&
    Number.isFinite(window) &&
    window > 0
    ? { used, window }
    : null;
}

/** The share of the window in use, rounded as every context display shows it; an over-full reading keeps its value. */
export const contextPercent = (c: ContextReading) => Math.round((c.used / c.window) * 100);

/**
 * The composer ring's tooltip: "42% used", "83.4k / 200k", then what to do next: from 95% compact, from 80% how far
 * auto-compact is (when the chat says where it starts), otherwise that a click shows usage.
 */
export function contextTip(c: ContextReading, compactAt: number | null = null): { used: string; tokens: string; hint: string } {
  const pct = contextPercent(c);
  const hint =
    pct >= 95
      ? 'Compact now to keep going'
      : pct >= 80 && compactAt !== null && compactAt > c.used
        ? `Auto-compacts in ${contextTokens(compactAt - c.used)} tokens`
        : 'Click for usage';
  return { used: `${contextShare(c.used, c.window)} used`, tokens: `${contextTokens(c.used)} / ${contextTokens(c.window)}`, hint };
}

/** Old reports remain useful for historical counters, but cannot describe a replacement session's context. */
export function reportedTokenUsage(state: Pick<AppState, 'runtime' | 'segments'>, chatId: string) {
  const runtime = state.runtime[chatId];
  return runtime?.tokenUsageOwner === contextUsageKey(state.segments?.[chatId], chatId) ? runtime.tokenUsage : null;
}
