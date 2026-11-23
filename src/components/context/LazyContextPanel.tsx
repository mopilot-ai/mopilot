// The context panel loaded when first opened (the ring's popover, the summary card): the composer and the summary panel stay free of what the panel reads (actions, accounts, the details dialog) until someone looks.
import { lazy, Suspense } from 'react';
import { useChatContext } from '../../session/useChatContext';
import type { ContextPanelProps } from './ContextPanel';
import { ContextLoading } from './ContextLoading';
import { ContextSummary } from './ContextSummary';

const ContextPanel = lazy(() => import('./ContextPanel').then((m) => ({ default: m.ContextPanel })));

export function LazyContextPanel({ threadId, onDone, compact = false, planLimits }: ContextPanelProps) {
  const reading = useChatContext(threadId, "read a chat's context while its panel loads");
  return (
    <Suspense
      fallback={
        compact ? (
          <div className="ctx-panel">
            <ContextSummary used={reading?.used ?? null} window={reading?.window ?? null} state="reading" />
            {planLimits}
          </div>
        ) : (
          <ContextLoading reading={reading} />
        )
      }
    >
      <ContextPanel threadId={threadId} onDone={onDone} compact={compact} planLimits={planLimits} />
    </Suspense>
  );
}
