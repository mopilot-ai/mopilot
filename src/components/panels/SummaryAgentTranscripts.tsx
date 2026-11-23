// The rail's read-only child transcripts, using the recorded links for agents outside its task inventory.
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store/core';
import { openSubThread } from '../../store/actions';
import { childThreads, type ChildThread } from '../../harness/codexTranslate';
import { agentTaskId } from '../../harness/codexTasks';
import { useDismissedIds } from '../../lib/dismissedTasks';
import type { BackgroundTask } from '../../store/session/sessionState';
import { Bot, ChevronDown, ChevronRight } from '../ui/icons';

type TranscriptLink = Pick<ChildThread, 'id' | 'title'>;

export function useTranscriptAgentLinks(chatId: string, tasks: readonly BackgroundTask[]): TranscriptLink[] {
  const represented = useMemo(() => new Set(tasks.map((task) => task.agentKey)), [tasks]);
  const dismissed = useDismissedIds(chatId);
  const flat = useStore(
    useShallow((s) => {
      const turns = s.runtime?.[chatId]?.turns ?? [];
      const owners = new Set([chatId, ...(s.segments?.[chatId] ?? []).map((segment) => segment.nativeId)]);
      return childThreads(turns.flatMap((turn) => turn.items))
        .filter(({ id }) => !owners.has(id) && !represented.has(id) && !dismissed.has(agentTaskId(id)))
        .flatMap(({ id, title }) => [id, title]);
    }),
  );
  return Array.from({ length: flat.length / 2 }, (_, i) => ({ id: flat[2 * i], title: flat[2 * i + 1] }));
}

export function SummaryAgentTranscripts({ threads }: { threads: TranscriptLink[] }) {
  return (
    <details className="summary-card summary-agent-transcripts">
      <summary className="summary-row summary-card-toggle">
        <Bot size={15} aria-hidden="true" />
        <span className="summary-label">Agent transcripts</span>
        <span className="summary-hint">{threads.length}</span>
        <ChevronDown size={13} className="summary-next" aria-hidden="true" />
      </summary>
      {threads.map(({ id, title }) => (
        <button key={id} type="button" className="summary-row" onClick={() => openSubThread(id, title)}>
          <Bot size={15} aria-hidden="true" />
          <span className="summary-label">{title}</span>
          <ChevronRight size={13} className="summary-next" aria-hidden="true" />
        </button>
      ))}
    </details>
  );
}
