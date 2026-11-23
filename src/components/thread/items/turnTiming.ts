// What a step row reads from its turn: when each item ran (for "Thought for 4s") and whether Stop cut the turn off
// (for "Interrupted" on a step it cut off), on every harness.

import { createContext, useContext } from 'react';
import { formatDuration } from '../../../lib/format';
import type { TurnState } from '../../../store/types';

export interface TurnTiming {
  /** when an item ran (read when the row renders: an item's end lands together with its completion) */
  timeOf: (id: string) => TurnState['itemTimes'][string] | undefined;
  /** the turn was stopped (not failed, not still running) */
  interrupted: boolean;
}

export const TurnTimingContext = createContext<TurnTiming>({ timeOf: () => undefined, interrupted: false });

export const useTurnTiming = () => useContext(TurnTimingContext);

/**
 * "Thought for 4s", as Claude Desktop and the Codex app label a finished stretch of thinking: the timed blocks' durations
 * summed and rounded to the second. "Thought" when no block was timed (a turn read back from history) or the sum rounds
 * to 0s, as Claude Desktop drops the duration under half a second (its ion-dist "Thought for {seconds}s" formatter).
 */
export function thoughtLabel(t: TurnTiming, ids: string[]): string {
  let ms = 0;
  for (const id of ids) {
    const at = t.timeOf(id);
    if (at?.end != null) ms += at.end - at.start;
  }
  return ms >= 500 ? `Thought for ${formatDuration(ms)}` : 'Thought';
}

/**
 * Whether Stop cut this step off: its harness marked it (`cutOff`: Claude Code, ACP), or it was still running when
 * the stopped turn ended (Codex leaves it in progress, as the Codex app's "Interrupted" reads it). A command sent to the
 * background outlives its turn: still running is not cut off.
 */
export function cutOffByStop(t: TurnTiming, item: { status?: string | null; cutOff?: boolean; background?: boolean }): boolean {
  return t.interrupted && (item.cutOff === true || (item.status === 'inProgress' && item.background !== true));
}
