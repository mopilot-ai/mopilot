// The composer's quick context view: one usage value and meter, with honest loading, stale and retry states.
import type { ContextState } from '../../session/useChatContext';
import { contextPercent, contextReading } from '../../store/contextUsage';
import { contextLevel, contextShare, contextTokens } from '../../lib/contextFormat';

export function ContextSummary({
  used,
  window: size,
  state,
  stale = false,
  onRetry = null,
}: {
  used: number | null;
  window: number | null;
  state: ContextState;
  stale?: boolean;
  onRetry?: (() => void) | null;
}) {
  const reading = contextReading(used, size);
  const percent = reading ? contextPercent(reading) : 0;
  const message =
    state === 'reading'
      ? 'Reading context use…'
      : state === 'unavailable'
        ? 'Context unavailable.'
        : stale
          ? 'Last reported usage.'
          : used === null
            ? 'Usage appears after the next turn.'
            : null;
  return (
    <div className="ctx-top ctx-summary" aria-busy={state === 'reading'}>
      <div className="ctx-head">
        <span className="ctx-title">Context window</span>
        <span className="ctx-summary-value" data-level={reading ? contextLevel(percent) : undefined}>
          {reading ? `${contextShare(reading.used, reading.window)} used` : used !== null ? `${contextTokens(used)} tokens used` : '—'}
        </span>
      </div>
      {reading && (
        <div
          className="ctx-summary-bar"
          role="meter"
          aria-label="Context used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, percent)}
          aria-valuetext={`${contextShare(reading.used, reading.window)} used, ${contextTokens(reading.used)} of ${contextTokens(reading.window)} tokens`}
          data-level={contextLevel(percent)}
        >
          <i style={{ width: `${Math.min(100, (reading.used / reading.window) * 100)}%` }} />
        </div>
      )}
      {message && (
        <p className="ctx-note" role="status" aria-busy={state === 'reading'}>
          {message}
          {onRetry && state !== 'reading' && (state === 'unavailable' || stale) && (
            <>
              {' '}
              <button type="button" className="ctx-retry" onClick={onRetry}>
                Retry
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}
