// The running-tasks count in the turn's status line (a ghost button that opens Background tasks and lingers on completion) and the Stop all question.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { MorphText } from '../ui/MorphText';
import { stopAllTasks } from '../../store/send';
import { useStore } from '../../store/core';
import { toggleTasksPane } from '../../store/panes';
import { awaitsApproval, FINISHED_HOLD_MS, finishedLabel, isRunningTask, runningLabel, waitingLabel } from '../../lib/tasks';
import { useSession } from '../../store/session/useSession';
import { useChatTasks } from './TaskList';

export interface PillState {
  /** still working, and not blocked on the user */
  running: number;
  /** running, but stopped on an approval only the user can answer */
  waiting: number;
  /** everything unsettled: running + waiting. The count Stop all offers to stop. */
  live: number;
  /** how many just finished, while the count lingers after the last one settled */
  finished: number | null;
}

/**
 * The counts: tasks still working, tasks parked on the user, and for 1.5 s after the last one settles, how
 * many there were. Waiting is derived from the chat's live approvals every render, never stored, so an
 * approval answered in another window stops counting here on the next render instead of going stale.
 */
export function useTasksPill(chatId: string): PillState {
  const approvals = useSession(chatId).approvals;
  const unsettled = useChatTasks(chatId).filter(isRunningTask);
  const waiting = unsettled.filter((t) => awaitsApproval(approvals, t)).length;
  const live = unsettled.length;
  const [prev, setPrev] = useState(live);
  const [finished, setFinished] = useState<number | null>(null);
  // the count is read in the render that sees it drop, so it goes from running straight to finished with no blank frame between
  if (prev !== live) {
    setPrev(live);
    setFinished(live ? null : prev);
  }
  useEffect(() => {
    if (live || finished == null) return;
    const t = setTimeout(() => setFinished(null), FINISHED_HOLD_MS);
    return () => clearTimeout(t);
  }, [live, finished]);
  return { running: live - waiting, waiting, live, finished: live ? null : finished };
}

/** The tool calls (Claude) and command items (Codex) whose background task still runs: their rows stay in view when a turn folds. */
export function useRunningCalls(chatId: string): ReadonlySet<string> {
  const ids = useChatTasks(chatId)
    .filter((t) => isRunningTask(t) && t.toolUseId)
    .map((t) => t.toolUseId!);
  const key = ids.join('\n');
  return useMemo(() => new Set(key ? key.split('\n') : []), [key]);
}

/** Whether the count shows: anything unsettled, or it lingers on how many finished. */
export const pillShown = (p: PillState) => p.live > 0 || p.finished != null;

/**
 * The count in the status line: plain text in a ghost button, pressed while the chat's Background tasks tab
 * is open. Tasks parked on the user get their own button beside it, so "4 running · 1 needs you" never reads
 * as five tasks all making progress.
 */
/** Whether the chat's Background tasks tab is the one open: what every count that opens it shows as pressed. */
export function useTasksTabPressed(chatId: string): boolean {
  return useStore((s) => {
    const tab = s.paneTabs.find((t) => t.kind === 'tasks');
    return !!(s.diffPanel.open && tab && s.paneActive === tab.id && tab.threadId === chatId);
  });
}

function TasksCount({ chatId, pill }: { chatId: string; pill: PillState }) {
  const pressed = useTasksTabPressed(chatId);
  const open = () => toggleTasksPane(chatId);
  if (!pill.live) {
    return (
      <button className="tasks-count" title="View background tasks" aria-pressed={pressed} onClick={open}>
        <MorphText morphKey="tasks-finished">{finishedLabel(pill.finished!)}</MorphText>
      </button>
    );
  }
  return (
    <>
      {pill.running > 0 && (
        <button className="tasks-count" title="View background tasks" aria-pressed={pressed} onClick={open}>
          <MorphText morphKey="running-tasks">{runningLabel(pill.running)}</MorphText>
        </button>
      )}
      {pill.waiting > 0 && (
        <button className="tasks-count waiting" title="View the tasks waiting for you" aria-pressed={pressed} onClick={open}>
          <MorphText morphKey="tasks-waiting">{waitingLabel(pill.waiting)}</MorphText>
        </button>
      )}
    </>
  );
}

/** " · 1 running task" after the running turn's clock, in the same status line. */
export function InlineTasksCount({ chatId }: { chatId: string }) {
  const pill = useTasksPill(chatId);
  if (!pillShown(pill)) return null;
  return (
    <span className="tasks-count-inline">
      <span className="tasks-count-sep" aria-hidden>
        ·
      </span>
      <TasksCount chatId={chatId} pill={pill} />
    </span>
  );
}

/**
 * The status line after a turn has ended while tasks still run: just the count. `extra`: more counts after it in the
 * same line (the chat's sessions, SessionsCount.tsx); the line shows for either.
 */
export function TasksStatusRow({ chatId, extra = null }: { chatId: string; extra?: ReactNode }) {
  const pill = useTasksPill(chatId);
  const shown = pillShown(pill);
  if (!shown && !extra) return null;
  return (
    <div className="tasks-status-row" role="status">
      {shown && <TasksCount chatId={chatId} pill={pill} />}
      {shown && extra && (
        <span className="tasks-count-sep" aria-hidden>
          ·
        </span>
      )}
      {extra}
    </div>
  );
}

/** The double Esc's question above the composer: stop every background task of the chat. */
export function StopAllConfirm({ chatId, running, setConfirm }: { chatId: string; running: number; setConfirm: (v: boolean) => void }) {
  return (
    <div className="queued">
      <div className="queued-item tasks-bar">
        <span className="queued-text">Stop all {running} background tasks?</span>
        <button className="link-btn" onClick={() => setConfirm(false)}>
          Cancel
        </button>
        <button
          className="link-btn"
          onClick={() => {
            setConfirm(false);
            void stopAllTasks(chatId);
          }}
        >
          Stop all
        </button>
      </div>
    </div>
  );
}
