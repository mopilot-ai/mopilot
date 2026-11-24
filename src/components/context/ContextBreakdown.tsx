// The top of a chat's context panel, the same in the composer ring's popover and the summary card: how full the window is (a headline share, a segmented bar with the compaction reserve at its end and where auto-compact starts, a plain-name legend), or what is known instead (nothing yet, tokens without a window), and how fresh it is.
import type { ReactNode } from 'react';
import { emptySnapshot, estimatedCategories, sinceBreakdown, type ContextSnapshot } from '../../../shared/contextSnapshot.mjs';
import { CONTEXT_UNREPORTED, contextLevel, contextShare, contextTokens } from '../../lib/contextFormat';
import type { ContextState } from '../../session/useChatContext';
import { contextReading } from '../../store/contextUsage';
import { contextMeter, shareOf, type ContextMeterModel } from './contextMeter';
import { money } from './ContextLists';
import { ContextLoading } from './ContextLoading';

/** When the snapshot was read: "3:42 PM" today, "Oct 20, 3:42 PM" on another day (snapshots are kept across restarts). */
export function timeOf(at: number, now = Date.now()) {
  const d = new Date(at);
  const time: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  return d.toDateString() === new Date(now).toDateString()
    ? d.toLocaleTimeString([], time)
    : d.toLocaleString([], { month: 'short', day: 'numeric', ...time });
}

/**
 * The snapshot to show: main's, else one made from a reading this window was reported (its split unknown), else null.
 */
export function shownSnapshot(snapshot: ContextSnapshot | null, reading: { used: number; window: number } | null): ContextSnapshot | null {
  // a snapshot emptied by a reset stands: the reading made here from before it is gone with it
  if (snapshot) return snapshot.used !== null ? snapshot : null;
  if (!reading) return null;
  const s = emptySnapshot('', 0);
  return { ...s, used: reading.used, window: reading.window, categories: estimatedCategories(reading.used, reading.window, null) };
}

/** What a breakdown is doing: compacting, refreshing after newer tokens, stale since a compaction or a failed read, or settled. */
export type Freshness = 'compacting' | 'updating' | 'stale' | 'settled';
export function freshnessOf(s: ContextSnapshot, compacting: boolean): Freshness {
  if (compacting) return 'compacting';
  if (s.stale) return 'stale';
  return sinceBreakdown(s) > 0 ? 'updating' : 'settled';
}

/** The bar: each segment's share of the window with 2px gaps, the reserve hatched at the end, and auto-compact's mark. */
export function ContextMeterBar({ model, fresh }: { model: ContextMeterModel; fresh: Freshness }) {
  return (
    <div className="ctx-bar-wrap" data-fresh={fresh}>
      <div
        className="ctx-bar"
        role="meter"
        aria-label="Context used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, Math.round(model.percent))}
        aria-valuetext={`${contextShare(model.used, model.window)} used, ${contextTokens(model.used)} of ${contextTokens(model.window)} tokens`}
      >
        {/* past the window there is nothing left to divide: the whole bar says so */}
        {model.over > 0 ? (
          <i className="ctx-seg" data-series="over" style={{ flexGrow: 1 }} />
        ) : (
          model.segments.map((x) => (
            <i key={x.id} className="ctx-seg" data-series={x.series} style={{ flexGrow: x.tokens }} title={x.label} />
          ))
        )}
      </div>
      {model.mark !== null && model.over === 0 && <i className="ctx-mark" style={{ left: `${model.mark}%` }} aria-hidden="true" />}
    </div>
  );
}

/** The legend: a row per group in the window with its tokens and share; deferred tools are left to the dialog. */
function Legend({ model }: { model: ContextMeterModel }) {
  return (
    <div className="ctx-legend">
      {model.legend
        .filter((r) => !r.outside)
        .map((r) => (
          <div key={r.id} className="ctx-legend-row" data-series={r.series}>
            <i className="ctx-swatch" data-series={r.series} aria-hidden="true" />
            <span className="ctx-legend-label">
              {r.label}
              {r.estimated && <span className="ctx-est">est.</span>}
            </span>
            <span className="ctx-num">{contextTokens(r.tokens)}</span>
            <span className="ctx-share">{shareOf(r, model.window)}</span>
          </div>
        ))}
    </div>
  );
}

/** The header's right side: what the breakdown is doing, how far past the window it is, or when it was read. */
function Status({ s, model, fresh }: { s: ContextSnapshot; model: ContextMeterModel | null; fresh: Freshness }) {
  if (fresh === 'compacting')
    return (
      <span className="ctx-status">
        <i className="ctx-spin" aria-hidden="true" />
        Compacting
      </span>
    );
  if (model && model.over > 0) return <span className="ctx-over">{contextTokens(model.over)} over</span>;
  if (fresh === 'stale')
    return (
      <span className="ctx-status">
        <i className="ctx-dot" aria-hidden="true" />
        {timeOf(s.breakdownAt ?? s.at)}
      </span>
    );
  if (fresh === 'updating') return <span className="ctx-status">Updating…</span>;
  return s.at > 0 ? <span className="ctx-status">Updated {timeOf(s.at)}</span> : null;
}

/** The notes under the meter, by what the breakdown is and does. */
function notesOf(s: ContextSnapshot, model: ContextMeterModel | null, fresh: Freshness, running: boolean, onRetry: (() => void) | null) {
  const notes: [string, ReactNode][] = [];
  if (!model) notes.push(['window', "This agent doesn't report its window size, so there's no meter."]);
  else if (model.over > 0) notes.push(['over', 'Compact to get back under the window.']);
  if (model && model.legend.some((r) => r.estimated)) notes.push(['est', 'The split is estimated from token totals.']);
  if (fresh === 'compacting') notes.push(['fresh', 'Summarizing the conversation']);
  if (fresh === 'updating' && running) notes.push(['fresh', 'Refreshing after this turn']);
  // a harness with a breakdown shows its last one and can read it again; the others update with their next report
  const stale =
    s.quality !== 'breakdown'
      ? 'Compacted since this reading; it updates when the next turn ends.'
      : s.stale === 'compacted'
        ? 'Showing the breakdown from before compacting.'
        : 'Showing the last breakdown.';
  if (fresh === 'stale')
    notes.push([
      'fresh',
      <>
        {stale}
        {onRetry && (
          <>
            {' '}
            <button type="button" className="ctx-retry" onClick={onRetry}>
              Retry
            </button>
          </>
        )}
      </>,
    ]);
  return notes;
}

/** A failed read keeps any known totals and offers another attempt where the harness can read a breakdown. */
function ReadFailure({ known = false, onRetry }: { known?: boolean; onRetry: (() => void) | null }) {
  return (
    <p className="ctx-note">
      {known ? "Couldn't load the breakdown." : "Couldn't read context use."}
      {onRetry && (
        <>
          {' '}
          <button type="button" className="ctx-retry" onClick={onRetry}>
            Retry
          </button>
        </>
      )}
    </p>
  );
}

/** Nothing reported yet, or a failed read with recovery. */
function Waiting({ unavailable, onRetry }: { unavailable: boolean; onRetry: (() => void) | null }) {
  return (
    <div className="ctx-top" data-empty="">
      <div className="ctx-head">
        <span className="ctx-title">Context window</span>
        <span className="ctx-status">{unavailable ? 'Context unavailable' : 'Waiting for a report'}</span>
      </div>
      <span className="ctx-big ctx-ghost">—</span>
      <div className="ctx-bar-ghost" aria-hidden="true" />
      {unavailable ? <ReadFailure onRetry={onRetry} /> : <p className="ctx-note">{CONTEXT_UNREPORTED}</p>}
    </div>
  );
}

/**
 * The window's use for a snapshot: the headline, the bar and legend when the window is known, the tokens alone when it
 * is not, a waiting state with nothing reported. `onRetry` reads a stale breakdown again, where there is one to read.
 */
export function ContextBreakdown({
  snapshot: s,
  state = 'none',
  running,
  compacting = false,
  onRetry,
}: {
  snapshot: ContextSnapshot | null;
  state?: ContextState;
  running: boolean;
  compacting?: boolean;
  onRetry: (() => void) | null;
}) {
  if (state === 'reading') return <ContextLoading reading={contextReading(s?.used, s?.window)} />;
  if (!s || s.used === null) return <Waiting unavailable={state === 'unavailable'} onRetry={onRetry} />;
  const model = contextMeter(s);
  const fresh = freshnessOf(s, compacting);
  return (
    <div className="ctx-top">
      <div className="ctx-head">
        <span className="ctx-title">Context window</span>
        <Status s={s} model={model} fresh={fresh} />
      </div>
      {model ? (
        <div className="ctx-figure">
          <span className="ctx-big" data-level={contextLevel(model.percent)} data-fresh={fresh}>
            {contextShare(model.used, model.window)}
          </span>
          <span className="ctx-unit">used</span>
          <span className="ctx-of">
            {contextTokens(model.used)} <span className="ctx-unit">/ {contextTokens(model.window)}</span>
          </span>
        </div>
      ) : (
        <div className="ctx-figure">
          <span className="ctx-big">{contextTokens(s.used)}</span>
          <span className="ctx-unit">tokens used</span>
        </div>
      )}
      {model && <ContextMeterBar model={model} fresh={fresh} />}
      {model && <Legend model={model} />}
      {s.cost && (
        <div className="ctx-cost">
          <span>Session cost</span>
          <span className="ctx-num">{money(s.cost)}</span>
        </div>
      )}
      {notesOf(s, model, fresh, running, onRetry).map(([key, note]) => (
        <p key={key} className="ctx-note" data-note={key}>
          {note}
        </p>
      ))}
      {state === 'unavailable' && <ReadFailure known onRetry={onRetry} />}
    </div>
  );
}
