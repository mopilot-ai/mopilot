// The rail links to the chat's actual plan and background work through the shared panes.
import { memoByObject } from '../../lib/memoByObject';
import { useStore } from '../../store/core';
import { toggleTasksPane } from '../../store/panes';
import { planDocument } from '../../store/plans/document';
import { openPlanPane } from '../../store/plans/pane';
import type { TurnState } from '../../store/types';
import { useChatTasks } from '../tasks/TaskList';
import { ChevronRight, ListChecks, SquareTerminal } from '../ui/icons';
import { useChatChecklist } from './useChatChecklist';
import { SummaryAgentTranscripts, useTranscriptAgentLinks } from './SummaryAgentTranscripts';

const hasProposal = memoByObject((turn: TurnState) => !!planDocument([turn], []));

export function SummaryActivity({ threadId }: { threadId: string }) {
  const checklist = useChatChecklist(threadId);
  const proposal = useStore((s) => s.runtime[threadId]?.turns.some(hasProposal) ?? false);
  const tasks = useChatTasks(threadId);
  const transcripts = useTranscriptAgentLinks(threadId, tasks);
  if (!checklist && !proposal && !tasks.length && !transcripts.length) return null;
  return (
    <section className="summary-group summary-activity" aria-label="Activity">
      {(checklist || proposal) && (
        <button type="button" className="summary-row summary-plan" onClick={() => openPlanPane(threadId)}>
          <ListChecks size={15} aria-hidden="true" />
          <span className="summary-label">Plan</span>
          {checklist && (
            <span className="summary-hint">
              {checklist.steps.filter((step) => step.status === 'completed').length} of {checklist.steps.length}
            </span>
          )}
          <ChevronRight size={13} className="summary-next" aria-hidden="true" />
        </button>
      )}
      {tasks.length > 0 && (
        <button type="button" className="summary-row" onClick={() => toggleTasksPane(threadId)}>
          <SquareTerminal size={15} aria-hidden="true" />
          <span className="summary-label">Background tasks</span>
          <span className="summary-hint">{tasks.length}</span>
          <ChevronRight size={13} className="summary-next" aria-hidden="true" />
        </button>
      )}
      {transcripts.length > 0 && <SummaryAgentTranscripts threads={transcripts} />}
    </section>
  );
}
