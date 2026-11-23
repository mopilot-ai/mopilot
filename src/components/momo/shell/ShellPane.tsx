// The shell's one side pane (Tasks, Files or Sessions, #4926): its width is dragged with the same handle as the rail's (SidebarResize, on its left edge, the design's 420 to 732) and kept, and it opens and closes in one frame; the close button and Esc close it.
import type { ReactNode } from 'react';
import { PANE_BOUNDS } from '../../../lib/sidebarSizing';
import { SidebarResize } from '../../sidebar/SidebarResize';
import { Plus, X } from '../../ui/icons';
import { MomoOutputs } from '../MomoOutputs';
import { SessionsPane } from '../sessions/SessionsPane';
import { TasksPanel } from '../tasks/TasksPanel';
import { SHELL_COPY } from './shellCopy';
import type { usePaneWidth } from './useRailWidth';
import type { ShellPanelId } from './useShellState';
import styles from './momoShell.module.css';

const BODY: Record<ShellPanelId, () => ReactNode> = {
  tasks: () => <TasksPanel />,
  files: () => <MomoOutputs />,
  sessions: () => <SessionsPane />,
};

export function ShellPane({
  panel,
  sizing,
  beside,
  close,
  channel,
  onNew,
}: {
  panel: ShellPanelId;
  /** the channel shown, when one is: it names the Tasks pane */
  channel?: string;
  /** the Tasks pane's +: where a new task is asked for */
  onNew: () => void;
  sizing: ReturnType<typeof usePaneWidth>;
  /** the rail's width beside it */
  beside: number;
  close: () => void;
}) {
  // Tasks in a channel says so ("Tasks in #name"), with + for a new task
  const title =
    panel === 'files'
      ? SHELL_COPY.files
      : panel === 'sessions'
        ? SHELL_COPY.sessions
        : channel
          ? SHELL_COPY.tasksIn(channel)
          : SHELL_COPY.tasks;
  return (
    <aside className={styles.panel} role="region" aria-label={title} style={{ width: sizing.width }}>
      <SidebarResize
        name="side pane"
        bounds={PANE_BOUNDS}
        edge="right"
        open
        width={sizing.width}
        dragging={sizing.dragging}
        onWidthChange={sizing.setWidth}
        onDraggingChange={sizing.setDragging}
        beside={beside}
        onOpenChange={(open) => open || close()}
        onSaveWidth={sizing.save}
      />
      <header className={styles.panelHead}>
        <h2 className={styles.panelTitle}>{title}</h2>
        <span className={styles.panelActions}>
          {panel === 'tasks' ? (
            <button type="button" className={styles.iconBtn} aria-label={SHELL_COPY.newTask} title={SHELL_COPY.newTask} onClick={onNew}>
              <Plus size={16} strokeWidth={1.8} />
            </button>
          ) : null}
          <button type="button" className={styles.iconBtn} aria-label={SHELL_COPY.close} title={SHELL_COPY.close} onClick={close}>
            <X size={16} strokeWidth={1.8} />
          </button>
        </span>
      </header>
      <div className={styles.panelBody}>{BODY[panel]()}</div>
    </aside>
  );
}
