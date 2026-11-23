// A turn's background task events in the transcript, for tasks no step row stands for: a 318 px card while one runs, else an inline line.
import { ChevronRight, Diamond } from '../ui/icons';
import { useSessionField } from '../../store/session/useSession';
import type { TaskEvent } from '../../store/types';
import { mergeTasks, useAdapterTasks } from '../../store/backgroundTasks';
import { toggleTasksPane } from '../../store/panes';
import { formatDuration } from '../../lib/format';
import { eventHeadline, eventsWithoutRow, groupParts, groupSummary, reconcileEvents } from '../../lib/taskEvents';
import { taskElapsed, useTaskClock } from '../../lib/tasks';
import { Shimmer } from '../thread/items/presentation';

export function TaskEventCard({ events: noted, chatId }: { events: TaskEvent[]; chatId?: string }) {
  const session = useSessionField(chatId, (s) => ({ tasks: s.tasks }));
  const adapter = useAdapterTasks(chatId ?? '');
  const tasks = mergeTasks(session.tasks, adapter);
  const events = reconcileEvents(eventsWithoutRow(noted, tasks), tasks);
  const single = events.length === 1 ? events[0] : null;
  const anyRunning = events.some((e) => e.status === 'running');
  const now = useTaskClock(!!single && anyRunning);
  if (!events.length) return null;
  const open = chatId ? () => toggleTasksPane(chatId) : undefined;

  // settled: one line, as Claude shows a finished task; a failure reads in the danger color
  if (!anyRunning) {
    const took = single && formatDuration(single.durationMs);
    const body = single ? (
      <span className="task-event-line">
        <span className={`task-event-head ${single.status === 'failed' ? 'task-failed' : ''}`}>{eventHeadline(single)}</span>
        {single.title && <span className="task-event-part task-event-title">· {single.title}</span>}
        {took && <span className="task-event-part task-time">· took {took}</span>}
      </span>
    ) : (
      <span className="task-event-line">
        {groupParts(events).map((p, i) => (
          <span key={p.text} className={`task-event-head ${p.danger ? 'task-failed' : ''}`}>
            {i > 0 && ', '}
            {p.text}
          </span>
        ))}
      </span>
    );
    return open ? (
      <button className="task-event-inline" onClick={open}>
        {body}
      </button>
    ) : (
      <div className="task-event-inline">{body}</div>
    );
  }

  // a single running task ticks its own timer, read from the chat's task list
  const live = single && tasks.find((t) => t.id === single.taskId);
  const elapsed = live ? taskElapsed(live, now) : null;
  const text = single ? single.title : groupSummary(events);
  return (
    <button className="task-event-card" onClick={open} disabled={!open}>
      <span className="task-event-surface" aria-hidden />
      <Diamond size={16} className="task-event-icon" />
      <span className="task-event-text">
        <span className={`task-event-label ${single ? 'single' : ''}`}>
          <Shimmer>{text}</Shimmer>
        </span>
        {elapsed != null && <span className="task-event-time">{formatDuration(elapsed)}</span>}
      </span>
      <ChevronRight size={16} className="task-event-icon" />
    </button>
  );
}
