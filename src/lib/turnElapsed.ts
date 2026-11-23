// How long a turn took, for its header ("Worked for 4s", "Stopped after 4s"): measured while it runs and once it has an end; a stopped turn nothing measured the end of has no duration (reading "now" there made "Stopped after 18h 33m" grow with the clock, #4926).
export function turnElapsed(
  turn: { startedAt?: number | null; completedAt?: number | null; durationMs?: number | null; status?: string },
  running: boolean,
  now: number,
  observedStart: number,
): number | null {
  if (running) return Math.max(0, now - (turn.startedAt ? turn.startedAt * 1000 : observedStart));
  if (turn.durationMs != null) return turn.durationMs;
  if (!turn.startedAt) return null;
  if (!turn.completedAt && turn.status === 'interrupted') return null;
  return (turn.completedAt ? turn.completedAt * 1000 : now) - turn.startedAt * 1000;
}
