// The session rail's Goal section, as Claude Desktop's: the chat's goal and where it stands while it is not met, on any harness
// that keeps one; Edit and Clear put the /goal command in an empty composer for the user to send, as Claude Desktop's do.
import { toast, useStore } from '../../store/core';
import { useSessions } from '../../store/session/useSession';
import { giveBackToComposer } from '../../store/send';
import { goalBarView } from '../thread/GoalBar';
import { Pencil, Trash2 } from '../ui/icons';
import { RailSection } from './RailSection';

export function SummaryGoal({ threadId }: { threadId: string }) {
  const goal = useSessions((s) => s.sessions[threadId]?.goal ?? null);
  const draft = useStore((s) => s.drafts?.[threadId]?.text ?? '');
  // as Claude Desktop's, a met goal leaves the rail
  if (!goal || goal.status === 'complete') return null;
  const view = goalBarView(goal);
  // the command replaces nothing: a message being written stays the user's
  const prefill = (command: string) =>
    draft.trim() ? toast('Send or clear your message first, then try again.', 'error') : giveBackToComposer(threadId, command);
  return (
    <RailSection chatId={threadId} id="goal" className="summary-goal" summary={view.status}>
      <p className="summary-goal-objective" title={goal.objective}>
        {goal.objective}
      </p>
      <div className="summary-goal-status">
        <span className="summary-hint">{view.detail ? `${view.status} · ${view.detail}` : view.status}</span>
        {view.canEditObjective && (
          <button
            type="button"
            className="icon-btn xs"
            title="Edit goal"
            aria-label="Edit goal"
            onClick={() => prefill(`/goal edit ${goal.objective}`)}
          >
            <Pencil size={13} />
          </button>
        )}
        <button type="button" className="icon-btn xs" title="Clear goal" aria-label="Clear goal" onClick={() => prefill('/goal clear')}>
          <Trash2 size={13} />
        </button>
      </div>
    </RailSection>
  );
}
