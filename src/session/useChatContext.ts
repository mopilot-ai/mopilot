// A chat's context use for every display (the composer ring, the context panel and card, the summary card, Status): main's snapshot (useContextSnapshot), else the reading this window was reported.
import { useStore } from '../store/core';
import { contextReading, reportedTokenUsage, type ContextReading } from '../store/contextUsage';
import { useContextAsk, useContextOwner, useContextSnapshot } from './useContextSnapshot';

/**
 * The chat's context reading, or null while none is known. Main hears every report before the windows do and reads
 * Claude Code's breakdown when its turn ends (or a compaction left it stale), so its snapshot stands; a report this
 * window received counts only until main's first push for the owner arrives, even one that empties it (a reset). A
 * reading belongs to the chat, harness and native session it was read for: a switch never shows the previous owner's.
 */
export function useChatContext(threadId: string | null, purpose: string): ContextReading | null {
  return useChatContextState(threadId, purpose).reading;
}

/**
 * Where the reading stands, for a display that says why it has none: `reading` while a read for this owner runs with
 * no snapshot to show, `unavailable` when that read answered with nothing usable or failed, `none` when the harness has
 * reported nothing yet.
 */
export type ContextState = 'ready' | 'reading' | 'unavailable' | 'none';

/** useChatContext's reading with where it stands (ContextState). */
export function useChatContextState(threadId: string | null, purpose: string): { reading: ContextReading | null; state: ContextState } {
  const usage = useStore((s) => (threadId ? reportedTokenUsage(s, threadId) : null));
  const snapshot = useContextSnapshot(threadId, purpose);
  const ask = useContextAsk(useContextOwner(threadId)?.owner ?? null);
  // a snapshot emptied by a reset stands too: the report from before it describes a conversation that is gone
  const reading = snapshot
    ? contextReading(snapshot.used, snapshot.window)
    : contextReading(usage?.last?.totalTokens, usage?.modelContextWindow);
  return { reading, state: reading ? 'ready' : (ask ?? 'none') };
}
