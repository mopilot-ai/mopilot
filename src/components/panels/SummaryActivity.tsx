// The rail links to the chat's actual plan and its agents' transcripts through the shared panes; running tasks have their own section.
import { memoByObject } from '../../lib/memoByObject';
import { useStore } from '../../store/core';
import { planDocument } from '../../store/plans/document';
import { openPlanPane } from '../../store/plans/pane';
import type { TurnState } from '../../store/types';
import { useChatTasks } from '../tasks/TaskList';
import { ChevronRight, ListChecks } from '../ui/icons';
import { useChatChecklist } from './useChatChecklist';
import { SummaryAgentTranscripts, useTranscriptAgentLinks } from './SummaryAgentTranscripts';
import { RailSection } from './RailSection';

const hasProposal = memoByObject((turn: TurnState) => !!planDocument([turn], []));

export function SummaryActivity({ threadId }: { threadId: string }) {
  const checklist = useChatChecklist(threadId);
  const proposal = useStore((s) => s.runtime[threadId]?.turns.some(hasProposal) ?? false);
  const tasks = useChatTasks(threadId);
  const transcripts = useTranscriptAgentLinks(threadId, tasks);
  if (!checklist && !proposal && !transcripts.length) return null;
  return (
    <RailSection chatId={threadId} id="activity" className="summary-activity">
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
      {transcripts.length > 0 && <SummaryAgentTranscripts threads={transcripts} />}
    </RailSection>
  );
}
