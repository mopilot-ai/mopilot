// Explicit provider recovery and repeated context compaction, shared by every harness; silence alone is normal work.
import type { TurnState } from '../../shared/model/store';

/** Compactions in a row with at most LOOP_GAP_STEPS steps between them read as a loop: the context is full before any history. */
export const LOOP_COMPACTIONS = 3;
const LOOP_GAP_STEPS = 3;
/** Not steps of the work: what the turn is told or thinks, and the compactions themselves. */
const NOT_STEPS = new Set<string>(['userMessage', 'reasoning', 'contextCompaction', 'statusNote', 'plan', 'hookPrompt']);

/**
 * How many times in a row the turn compacted its context without getting further, or 0: a harness whose fixed context
 * (its tools, a large MCP server among them, and instructions) nearly fills the model's window compacts after every
 * step, and no compaction can shrink what is fixed. The run is broken once the turn gets more steps done than that.
 */
export function compactionLoop(items: readonly { type: string }[]): number {
  let run = 0;
  let steps = 0;
  for (const i of items) {
    if (i.type === 'contextCompaction') {
      run = run && steps > LOOP_GAP_STEPS ? 1 : run + 1;
      steps = 0;
    } else if (!NOT_STEPS.has(i.type)) steps++;
  }
  return run >= LOOP_COMPACTIONS && steps <= LOOP_GAP_STEPS ? run : 0;
}

/** What to do about a compaction loop, under its banner and in the note a turn that ended in one keeps. */
export const COMPACTING_NEXT_STEP = 'Tools and MCP servers may fill the context. Turn some off.';

export type TurnStall = { kind: 'retry'; text: string } | { kind: 'compacting'; count: number } | null;

/** Recovery comes from the adapter, never elapsed time. A question or approval takes priority over a compaction loop. */
export function turnStall(o: {
  turn: Pick<TurnState, 'status' | 'items'> | null | undefined;
  retry: string | null | undefined;
  asked: boolean;
}): TurnStall {
  if (o.retry) return { kind: 'retry', text: o.retry };
  if (!o.turn || o.turn.status !== 'inProgress' || o.asked) return null;
  const count = compactionLoop(o.turn.items);
  return count ? { kind: 'compacting', count } : null;
}
