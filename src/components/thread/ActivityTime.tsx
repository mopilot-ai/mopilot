// The elapsed-time label on a running turn.
import { formatDuration } from '../../lib/format';

/** A quiet clock: label changes announce progress, rather than every elapsed second. */
export function ActivityTime({ elapsedMs }: { elapsedMs: number | null }) {
  return (
    <span className="activity-time" role="timer" aria-live="off" aria-label="Elapsed time">
      {formatDuration(Math.max(0, elapsedMs ?? 0)) || '0s'}
    </span>
  );
}
