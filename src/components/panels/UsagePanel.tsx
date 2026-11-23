// The side pane's Usage: every login's plan limits (PlanUsage), then this chat's own use, which belongs to its current native model session; missing reports never appear as a zero or estimated cost.
import { useStore } from '../../store/core';
import { reportedTokenUsage } from '../../store/contextUsage';
import { useChatContextState } from '../../session/useChatContext';
import { contextTokens } from '../../lib/contextFormat';
import { PlanUsage } from './PlanUsage';

export function UsagePanel({ threadId }: { threadId: string }) {
  const usage = useStore((s) => reportedTokenUsage(s, threadId));
  const { reading, state } = useChatContextState(threadId, 'read usage in the side pane');
  const total = usage?.total.totalTokens;
  const hasTotal = typeof total === 'number' && Number.isFinite(total) && total > 0;
  return (
    <section className="session-pane" aria-label="Session usage">
      <header>
        <h2>Usage</h2>
      </header>
      <PlanUsage threadId={threadId} />
      <h3>This chat</h3>
      <p>Reported for the current model session. A change of agent or a new native session starts a separate report.</p>
      <dl className="session-usage">
        <dt>Context used</dt>
        <dd>{reading ? contextTokens(reading.used) : state === 'reading' ? 'Reading…' : 'Not reported'}</dd>
        <dt>Context window</dt>
        <dd>{reading ? contextTokens(reading.window) : 'Not reported'}</dd>
        <dt>Reported token total</dt>
        <dd>{hasTotal ? contextTokens(total) : 'Not reported'}</dd>
        <dt>Cost</dt>
        <dd>Not reported</dd>
      </dl>
      <p>Token totals and context size measure different things. Cost is shown only when the service supplies it.</p>
    </section>
  );
}
