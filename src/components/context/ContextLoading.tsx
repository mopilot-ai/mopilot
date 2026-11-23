// The context disclosure's lightweight loading outline, shared by its code and data waits, retaining any known usage.
import type { ContextReading } from '../../store/contextUsage';
import { contextShare, contextTokens } from '../../lib/contextFormat';

const ROWS = ['instructions', 'tools', 'memory', 'conversation', 'free'];

export function ContextLoading({ reading }: { reading: ContextReading | null }) {
  return (
    <div className="ctx-top ctx-loading" role="status" aria-busy="true" aria-label="Loading context breakdown">
      <div className="ctx-head">
        <span className="ctx-title">Context window</span>
        <span className="ctx-status">Loading breakdown…</span>
      </div>
      <div className="ctx-figure">
        <span className="ctx-big ctx-ghost">{reading ? contextShare(reading.used, reading.window) : '—'}</span>
        {reading && (
          <>
            <span className="ctx-unit">used</span>
            <span className="ctx-of">
              {contextTokens(reading.used)} <span className="ctx-unit">/ {contextTokens(reading.window)}</span>
            </span>
          </>
        )}
      </div>
      <div className="ctx-loading-shapes" aria-hidden="true">
        <div className="ctx-loading-bar" />
        <div className="ctx-legend">
          {ROWS.map((row) => (
            <div className="ctx-loading-row" key={row}>
              <i className="ctx-swatch" />
              <i className="ctx-loading-label" />
              <i className="ctx-loading-value" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
