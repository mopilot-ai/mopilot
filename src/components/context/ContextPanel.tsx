// Context disclosures share chat-owned usage and plan limits: the composer gets a quick summary; the side card adds composition, compaction and chat details.
import type { ReactNode } from 'react';
import { useStore } from '../../store/core';
import { chatFamily } from '../../store/chats';
import { firstTierOf } from '../../harness/family';
import type { HarnessId } from '../../harness/types';
import { useChatAccountView } from '../../session/harness/chatAccountView';
import type { ContextSnapshot } from '../../../shared/contextSnapshot.mjs';
import { contextTokens } from '../../lib/contextFormat';
import { ChevronRight } from '../ui/icons';
import { LimitMeters } from '../accounts/meters';
import { ContextBreakdown } from './ContextBreakdown';
import { ContextSummary } from './ContextSummary';
import { useCompact } from './useCompact';
import { useContextView } from './useContextView';
import { OPEN_CONTEXT } from './ContextCard';

function PlanLimits({ h, threadId }: { h: HarnessId; threadId: string }) {
  const { windows } = useChatAccountView(h, threadId);
  if (!windows.length) return null;
  return (
    <section className="ctx-limits" aria-label="Usage limits">
      <span className="ctx-title">Usage limits</span>
      <LimitMeters windows={windows} variant="rows" />
    </section>
  );
}

/** What the compact row says: where auto-compact starts and how far off it is, or what compacting does. */
export function compactLines(auto: ContextSnapshot['autoCompact'], used: number): [string, string | null] {
  if (!auto) return ['Summarize the conversation to free up space.', null];
  if (!auto.enabled) return ['Auto-compact is off', 'Summarize the conversation to free up space.'];
  if (!auto.threshold) return ['Auto-compacts near the limit', 'Or free up space now.'];
  const left = auto.threshold - used;
  return [
    `Auto-compacts at ${contextTokens(auto.threshold)}`,
    left > 0 ? `${contextTokens(left)} to go, or free space now` : 'Compact now to keep going',
  ];
}

function CompactRow({
  s,
  why,
  compacting,
  queued,
  label,
  onCompact,
}: {
  s: ContextSnapshot;
  why: string | null;
  compacting: boolean;
  queued: boolean;
  label: string;
  onCompact: () => void;
}) {
  // a snapshot is shown only with its used tokens (shownSnapshot)
  const [line, sub] = why
    ? [why, null]
    : queued
      ? ['Will compact after the current turn.', null]
      : compactLines(s.autoCompact, s.used as number);
  return (
    <div className="ctx-compact" data-blocked={why ? '' : undefined}>
      <div className="ctx-compact-text">
        <span>{line}</span>
        {sub && <span className="ctx-sub">{sub}</span>}
      </div>
      <button type="button" className="ctx-compact-btn" disabled={!!why || compacting || queued} onClick={onCompact}>
        {label}
      </button>
    </div>
  );
}

export type ContextPanelProps = { threadId: string; onDone?: () => void; compact?: boolean; planLimits?: ReactNode };

export function ContextPanel({ threadId, onDone, compact = false, planLimits }: ContextPanelProps) {
  const { snapshot, state, running, retry } = useContextView(threadId, "read a chat's context for its context panel");
  const h = useStore(() => (compact ? null : firstTierOf(chatFamily(threadId))));
  const { why, queued, compacting, compact: compactContext, label } = useCompact(threadId, running);
  const open = (event: string) => () => {
    onDone?.();
    window.dispatchEvent(new CustomEvent(event, { detail: threadId }));
  };
  return (
    <div className="ctx-panel">
      {compact ? (
        <ContextSummary
          used={snapshot?.used ?? null}
          window={snapshot?.window ?? null}
          state={state}
          stale={!!snapshot?.stale}
          onRetry={retry}
        />
      ) : (
        <ContextBreakdown snapshot={snapshot} state={state} running={running} compacting={compacting} onRetry={retry} />
      )}
      {!compact && snapshot && (
        <CompactRow s={snapshot} why={why} compacting={compacting} queued={queued} label={label} onCompact={compactContext} />
      )}
      {compact ? planLimits : h && <PlanLimits h={h} threadId={threadId} />}
      <div className="ctx-foot">
        {(snapshot || compact) && (
          <button type="button" className="ctx-foot-link" onClick={open(OPEN_CONTEXT)}>
            {compact ? 'View context' : 'Full breakdown'} <ChevronRight size={12} aria-hidden="true" />
          </button>
        )}
        {!compact && (
          <button type="button" className="ctx-foot-link" onClick={open('open-status')}>
            Chat details <ChevronRight size={12} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
