// The session rail's Background tasks section, as Claude Desktop's: the chat's running tasks on any harness, four before
// "Show more", each opening its agent's transcript or the tasks pane, with a Stop button and the finished ones' count.
import { useState } from 'react';
import { cardKind, isRunningTask, taskElapsed, taskTitle, useTaskClock, type CardKind } from '../../lib/tasks';
import { formatDuration } from '../../lib/format';
import { stopBackgroundTask, useStoppingIds } from '../../store/backgroundTasks';
import { toastFailure } from '../../store/core';
import { openAgentPage, openPaneTab } from '../../store/panes';
import type { BackgroundTask } from '../../store/session/sessionState';
import { useChatTasks } from '../tasks/TaskList';
import { Bot, Square, SquareTerminal, Workflow } from '../ui/icons';
import { RailSection } from './RailSection';

/** Rows shown before "Show more". */
const TASKS_SHOWN = 4;

const KIND_ICON: Partial<Record<CardKind, typeof Bot>> = { agent: Bot, shell: SquareTerminal, workflow: Workflow };

export function SummaryBackgroundTasks({ threadId }: { threadId: string }) {
  const tasks = useChatTasks(threadId);
  const running = tasks.filter(isRunningTask);
  const finished = tasks.length - running.length;
  const stopping = useStoppingIds(threadId);
  const now = useTaskClock(running.length > 0);
  const [all, setAll] = useState(false);
  // as Claude Desktop's, the section is there while something runs (the finished count rides along); the tasks pane stays
  // reachable from the composer's tasks pill and /tasks
  if (!running.length) return null;
  const shown = all ? running : running.slice(0, TASKS_SHOWN);
  const open = (t: BackgroundTask) =>
    t.agentKey ? openAgentPage(threadId, t.agentKey, taskTitle(t)) : openPaneTab('tasks', { threadId, views: [] });
  const stop = (t: BackgroundTask) =>
    stopBackgroundTask(threadId, t)
      .then((ok) => {
        if (ok === false) throw new Error("this task can't be stopped from here");
      })
      .catch(toastFailure(`Couldn't stop ${taskTitle(t)}`));
  return (
    <RailSection chatId={threadId} id="backgroundTasks" className="summary-background-tasks" summary={`${running.length} running`}>
      {shown.map((t) => {
        const Icon = KIND_ICON[cardKind(t.type)] ?? SquareTerminal;
        const elapsed = taskElapsed(t, now);
        const title = taskTitle(t);
        return (
          <div key={t.id} className="summary-task">
            <button
              type="button"
              className="summary-row"
              title={t.agentKey ? `View transcript for ${title}` : `Open ${title} in Background tasks`}
              onClick={() => open(t)}
            >
              <Icon size={15} aria-hidden="true" />
              <span className="summary-label">{title}</span>
              <span className="summary-hint">{stopping.has(t.id) ? 'Stopping…' : elapsed != null ? formatDuration(elapsed) : ''}</span>
            </button>
            {t.stoppable !== false && (
              <button
                type="button"
                className="icon-btn xs summary-task-stop"
                title="Stop this task"
                aria-label={`Stop ${title}`}
                disabled={stopping.has(t.id)}
                onClick={() => stop(t)}
              >
                <Square size={12} />
              </button>
            )}
          </div>
        );
      })}
      {running.length > TASKS_SHOWN && (
        <button type="button" className="summary-row muted" aria-expanded={all} onClick={() => setAll(!all)}>
          <span className="summary-label">{all ? 'Show less' : 'Show more'}</span>
        </button>
      )}
      {finished > 0 && (
        <button type="button" className="summary-row muted" onClick={() => openPaneTab('tasks', { threadId, views: [] })}>
          <span className="summary-label">{finished} finished</span>
        </button>
      )}
    </RailSection>
  );
}
