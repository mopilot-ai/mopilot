// Floating context disclosure: the chat's context use (useChatContext) as a row with tokens and a meter, opening into its context panel (context/ContextPanel.tsx).
import { contextLevel, contextShare, contextTokens } from '../../lib/contextFormat';
import { contextPercent } from '../../store/contextUsage';
import { useChatContext } from '../../session/useChatContext';
import { ChevronDown } from '../ui/icons';
import { useState } from 'react';
import { LazyContextPanel } from '../context/LazyContextPanel';

export function SummaryContext({ threadId }: { threadId: string }) {
  const context = useChatContext(threadId, "read a chat's context use for its summary");
  const percent = context ? contextPercent(context) : null;
  // the panel loads and reads only while the card is open
  const [open, setOpen] = useState(false);
  return (
    <details
      className="summary-card summary-context"
      // quiet while there is room, amber from 80%, red from 95%, as the composer's ring
      data-level={percent === null ? undefined : contextLevel(percent)}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="summary-card-toggle">
        <span className="summary-context-label">Context</span>
        {context && <span className="summary-context-tokens">{`${contextTokens(context.used)} / ${contextTokens(context.window)}`}</span>}
        <span className="summary-context-value">{context ? contextShare(context.used, context.window) : '—'}</span>
        <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
        {percent !== null && <meter aria-label="Context used" min={0} max={100} value={Math.min(percent, 100)} />}
      </summary>
      <div className="summary-group">{open && <LazyContextPanel threadId={threadId} />}</div>
    </details>
  );
}
