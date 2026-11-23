// A harness update's progress while it runs: the time it has taken (an npm or Homebrew download prints nothing for
// minutes on a slow connection, #3518) and, under its terminal, why it is still going or why it runs again.
import { useEffect, useState } from 'react';
import { formatDuration } from '../../lib/format';
import { visiblePoll } from '../../lib/visiblePoll';

/** After this long a run is said to be still working, so a silent download doesn't read as stuck. */
export const SLOW_MS = 20_000;

/** The time since `startedAt`, advancing each second while `running`; null without a start. */
export function useElapsed(startedAt: number | null | undefined, running: boolean): number | null {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running || startedAt == null) return;
    setNow(Date.now());
    // one shared second tick for every update on screen
    return visiblePoll('harness-update-elapsed', 1000, () => setNow(Date.now()));
  }, [running, startedAt]);
  return startedAt == null ? null : Math.max(0, now - startedAt);
}

/** The run's elapsed time as the pill shows it ("1m 5s"); empty before the first second. */
export const elapsedText = (ms: number | null) => (ms == null ? '' : formatDuration(ms));

/** The line under the update's terminal: a second download said as one, a long one as still working; else none. */
export function progressNote(retrying: boolean, elapsedMs: number | null): string | null {
  if (retrying) return "The first download didn't finish. Downloading again.";
  if (elapsedMs != null && elapsedMs >= SLOW_MS) return 'Still downloading. This can take a few minutes on a slow connection.';
  return null;
}

export function UpdateProgressNote({ retrying, elapsedMs }: { retrying: boolean; elapsedMs: number | null }) {
  const note = progressNote(retrying, elapsedMs);
  return note ? (
    <span className="install-note" role="status">
      {note}
    </span>
  ) : null;
}
