// The chat's context dialog, the panel's "Full breakdown": a grid of the window in the bar's palette, every group in plain names opening into the names it was reported as and what each holds, the tokens measured, and Compact now; the same for every harness, as far as it reports.
import { useState } from 'react';
import { useChatContextState, type ContextState } from '../../session/useChatContext';
import { askContext, useContextOwner } from '../../session/useContextSnapshot';
import { contextShare, contextTokens } from '../../lib/contextFormat';
import { useEffectOn } from '../../lib/effects';
import { noteIgnored } from '../../lib/ignored';
import type { ContextSnapshot } from '../../../shared/contextSnapshot.mjs';
import { CategoryRows, TokenTable } from './ContextLists';
import { cellsOf, contextMeter, type ContextMeterModel } from './contextMeter';
import { timeOf } from './ContextBreakdown';
import { useCompact } from './useCompact';
import { useContextView } from './useContextView';
import { Modal } from '../ui/Modal';

/** Opens the card for the chat in the event's detail (the context panel's "Full breakdown"). */
export const OPEN_CONTEXT = 'open-context';
/** What the card says while it has no reading, by where the reading stands. */
const EMPTY: Record<Exclude<ContextState, 'ready'>, string> = {
  reading: 'Reading context use…',
  unavailable: "Context use isn't available right now.",
  none: "Usage shows here when this chat's next turn ends.",
};
/** The grid's cells, one per percent of the window: a cell is its place in the grid. */
const CELLS = Array.from({ length: 100 }, (_, n) => `cell-${n}`);

/** The card's headline: the share used, where auto-compact starts, when it was read, and used of the window. */
function Head({ s, model }: { s: ContextSnapshot; model: ContextMeterModel | null }) {
  const meta = [
    s.autoCompact?.enabled && s.autoCompact.threshold && `auto-compacts at ${contextTokens(s.autoCompact.threshold)}`,
    s.at > 0 && `updated ${timeOf(s.at)}`,
  ].filter(Boolean);
  return (
    <div className="ctx-card-head">
      <div className="ctx-card-figure">
        <span className="ctx-card-big">{model ? contextShare(model.used, model.window) : contextTokens(s.used as number)}</span>
        <span className="ctx-unit">{model ? 'of the window used' : 'tokens used'}</span>
        {meta.length > 0 && <span className="ctx-card-meta">{meta.join(' · ')}</span>}
      </div>
      {model && (
        <span className="ctx-card-of">
          {contextTokens(model.used)} <span className="ctx-unit">/ {contextTokens(model.window)} tokens</span>
        </span>
      )}
    </div>
  );
}

/** The window as a grid of cells in the bar's order and palette. */
function Grid({ model }: { model: ContextMeterModel }) {
  const cells = cellsOf(model, CELLS.length);
  return (
    <div className="ctx-card-grid-wrap">
      <div
        className="ctx-card-grid"
        role="img"
        aria-label={`Context window: ${contextShare(model.used, model.window)} of ${contextTokens(model.window)} tokens used`}
      >
        {CELLS.map((cell, n) => (
          <i key={cell} className="ctx-cell" data-series={cells[n]} />
        ))}
      </div>
      <p className="ctx-note">Each cell is {contextTokens(model.window / CELLS.length)} tokens.</p>
    </div>
  );
}

/** The card: the panel's snapshot, broken down as far as the chat's harness can say, read in full when it can. */
export function ContextCard({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const { state } = useChatContextState(threadId, "read a chat's context use for its card");
  const { snapshot, running } = useContextView(threadId, "read a chat's context use for its card");
  const own = useContextOwner(threadId);
  const { why, queued, compacting, compact, label } = useCompact(threadId, running);
  // a harness with a breakdown counts every category again; the card shows what it has meanwhile
  const [counting, setCounting] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffectOn([own?.owner], () => {
    if (!own?.breakdown) return;
    let live = true;
    setCounting(true);
    askContext(own.owner, true, 'full')
      .catch((error) => {
        noteIgnored("read a chat's full context breakdown", error);
        if (live) setFailed(true);
      })
      .finally(() => live && setCounting(false));
    return () => {
      live = false;
    };
  });
  const model = contextMeter(snapshot);
  return (
    <Modal title="Context" onClose={onClose}>
      <div className="ctx-card">
        {snapshot ? (
          <Head s={snapshot} model={model} />
        ) : (
          <p className="context-card-empty">{EMPTY[state as Exclude<ContextState, 'ready'>]}</p>
        )}
        {model && <Grid model={model} />}
        {snapshot && counting && <p className="ctx-note">Counting every category…</p>}
        {failed && <p className="ctx-note">Couldn't count every category; this is the last breakdown.</p>}
        {model && snapshot && <CategoryRows model={model} lists={snapshot.lists} details={snapshot.details} />}
        {snapshot && <TokenTable lastRequest={snapshot.lastRequest} session={snapshot.session} cost={snapshot.cost} />}
      </div>
      <div className="ctx-card-foot">
        <span className="ctx-note">
          {why ??
            (queued ? 'Will compact after the current turn.' : 'Compacting summarizes the chat and keeps instructions, tools and memory.')}
        </span>
        <button
          type="button"
          className="btn-pill"
          onClick={() => {
            onClose();
            window.dispatchEvent(new CustomEvent('open-status', { detail: threadId }));
          }}
        >
          Chat details
        </button>
        {snapshot && (
          <button type="button" className="btn-white" disabled={!!why || compacting || queued} onClick={compact}>
            {label}
          </button>
        )}
      </div>
    </Modal>
  );
}
