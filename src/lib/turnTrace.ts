// The turn trace in the window (#3571, G5): a saved trace's shape (electron/capabilities/browser/devtools/turnTrace.cjs), which trace belongs to a turn, which step a frame shows, and each step's line, for Replay on a turn.
import { assetUrl } from './paths';
import { browserStep } from './agentNarration/tools';

export type TurnTraceAction = {
  tool: string;
  args: Record<string, unknown>;
  at: number;
  ms: number;
  ok: boolean;
  error: string | null;
  /** frames saved before the action began, and once it ended: its before frame is before - 1, its after frame after - 1 */
  before: number;
  after: number;
};
export type TurnTrace = {
  version: number;
  id: string;
  startedAt: number;
  endedAt: number;
  width: number;
  height: number;
  frames: { file: string; at: number }[];
  actions: TurnTraceAction[];
  droppedActions: number;
  console: { at: number; level: string; text: string }[];
  requests: number;
  har: string | null;
  /** the trace's folder (main adds it when listing) */
  dir: string;
};

/** Turn times are whole seconds (and a harness may round them): a second of slack on either side. */
const SECOND_MS = 1000;

/**
 * The trace of a turn: the latest one that started within the turn's time (`startedAt`, `completedAt` in seconds, as
 * turns carry them) and ended as it ended, or null. A running turn (no completedAt) has no trace yet.
 */
export function traceOfTurn(traces: readonly TurnTrace[], startedAt?: number | null, completedAt?: number | null): TurnTrace | null {
  if (!startedAt || !completedAt) return null;
  const from = startedAt * 1000 - SECOND_MS;
  const to = completedAt * 1000 + SECOND_MS;
  // a trace ends with its turn: a quick turn just before a browser turn started in time but ended long before its trace
  const end = completedAt * 1000;
  for (let i = traces.length - 1; i >= 0; i--) {
    const t = traces[i];
    if (t.startedAt >= from && t.startedAt <= to && Math.abs(t.endedAt - end) <= SECOND_MS * 2) return t;
  }
  return null;
}

/** The action a frame shows: the last one that began at or before the frame. */
export function actionAtFrame(trace: TurnTrace, frame: number): number {
  const at = trace.frames[frame]?.at ?? -Infinity;
  let found = -1;
  trace.actions.forEach((a, i) => {
    if (a.at <= at) found = i;
  });
  return found;
}

/** The frame to show for an action: its after frame, or its before one when it painted nothing new. */
export function frameOfAction(trace: TurnTrace, action: number): number {
  const a = trace.actions[action];
  if (!a || !trace.frames.length) return 0;
  return Math.max(0, Math.min(trace.frames.length - 1, (a.after > a.before ? a.after : a.before) - 1));
}

/** An action's line, as the turn's own steps read (past tense). */
export function actionLine(a: TurnTraceAction): string {
  return browserStep(a.tool.replace(/^(?:browser|chrome)_/, ''), a.args as Record<string, unknown>, '')[0];
}

/** The URL a trace's frame loads from (main's codex-asset protocol). */
export const frameUrl = (trace: TurnTrace, frame: number) =>
  trace.frames[frame] ? assetUrl(`${trace.dir}/${trace.frames[frame].file}`) : null;
