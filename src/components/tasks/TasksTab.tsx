// The side pane's Background tasks tab: its 32 px header (back, title, clear finished, expand, close) over the task list or an agent's page.
import { ChevronLeft, ExternalLink, Maximize2, Minimize2, Trash2, X } from '../ui/icons';
import { agentHash } from '../../lib/deepLink';
import { native } from '../../lib/native';
import { AgentPage } from '../agents/AgentPage';
import { closePaneTab } from '../../store/panes';
import { set as setState, useStore } from '../../store/core';
import { popPaneView } from '../../store/panes';
import type { PaneTab } from '../../store/state';
import { dismissTasks } from '../../lib/dismissedTasks';
import { isRunningTask } from '../../lib/tasks';
import { TaskList, useChatTasks } from './TaskList';
import { TaskSessions, useStartedBy } from './TaskSessions';

export function TasksTab({ tab, chatId, cwd }: { tab: PaneTab; chatId: string; cwd: string }) {
  const views = tab.views ?? [];
  const top = views[views.length - 1];
  const full = useStore((s) => s.paneFull);
  // the chats it started lead the list (kept out of TaskList, which the status line's count also reads)
  const sessions = useStartedBy(chatId).length;
  const finished = useChatTasks(chatId)
    .filter((t) => !isRunningTask(t))
    .map((t) => t.id);
  return (
    <div className="tasks-tab">
      <div className="tasks-tab-head">
        <div className="tasks-tab-lead">
          {top && (
            <button className="pane-icon-btn" aria-label="Back" title="Back" onClick={() => popPaneView(tab.id)}>
              <ChevronLeft size={16} />
            </button>
          )}
          <span className="tasks-tab-title">{top?.title ?? 'Background tasks'}</span>
        </div>
        <div className="tasks-tab-actions">
          {!top && (
            <button
              className="pane-icon-btn"
              aria-label="Clear finished tasks"
              title="Clear finished tasks"
              aria-disabled={!finished.length}
              onClick={() => finished.length && dismissTasks(chatId, finished)}
            >
              <Trash2 size={16} />
            </button>
          )}
          {top && (
            <button
              className="pane-icon-btn"
              aria-label="Open in new window"
              title="Open in new window"
              onClick={() => native.win.open(agentHash(chatId, top.key, top.title))}
            >
              <ExternalLink size={16} />
            </button>
          )}
          <button
            className="pane-icon-btn"
            aria-label={full ? 'Collapse' : 'Expand'}
            title={full ? 'Collapse' : 'Expand'}
            onClick={() => setState({ paneFull: !full })}
          >
            {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button className="pane-icon-btn" aria-label="Close" title="Close" onClick={() => closePaneTab(tab.id)}>
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="tasks-tab-body">
        {top ? (
          <AgentPage chatId={chatId} agentKey={top.key} cwd={cwd} />
        ) : (
          <TaskList chatId={chatId} lead={sessions > 0 && <TaskSessions chatId={chatId} />} />
        )}
      </div>
    </div>
  );
}
