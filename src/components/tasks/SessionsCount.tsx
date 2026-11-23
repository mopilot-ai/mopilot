// The status line's counts of what a chat started, on any harness: ghost buttons beside the tasks count (TasksPill.tsx)
// for its sessions that run, wait their turn, need the user or went wrong. The PR rail is separate (PrCount.tsx). "Needs
// you" opens the first session blocked on the user, where its approval or question is; the others open Background tasks
// (TaskSessions.tsx). Stop all still stops only tasks.
import { Fragment, type ReactElement } from 'react';
import { toggleTasksPane } from '../../store/panes';
import { openChatFrom } from '../../session/openChat';
import { NEEDS_USER, WENT_WRONG, SessionStateProbe, type SessionCardState } from '../thread/SessionCard';
import { useSessionStates } from '../thread/sessionStates';
import { usePrLine } from '../thread/prLine';
import { InlineTasksCount, TasksStatusRow, useTasksTabPressed } from './TasksPill';
import { useStartedBy } from './TaskSessions';

export const sessionsRunningLabel = (n: number) => (n === 1 ? '1 session running' : `${n} sessions running`);
export const sessionsWaitingLabel = (n: number) => (n === 1 ? '1 session needs you' : `${n} sessions need you`);
export const sessionsQueuedLabel = (n: number) => (n === 1 ? '1 session queued' : `${n} sessions queued`);
export const sessionsFailedLabel = (n: number) => (n === 1 ? '1 session failed' : `${n} sessions failed`);

export type SessionCounts = {
  running: number;
  /** waiting its turn: a free slot (queued) or another session (waiting); not running yet */
  queued: number;
  /** the sessions blocked on the user, in the chat's order: "needs you" counts them and opens the first */
  needs: string[];
  failed: number;
};

const RUNNING: ReadonlySet<SessionCardState> = new Set(['starting', 'working']);
const QUEUED: ReadonlySet<SessionCardState> = new Set(['queued', 'waiting']);

/**
 * The line's counts from each session's known state, and the one list "needs you" both counts and opens, so the count
 * never names more than the user can reach. A session whose state the window doesn't know yet counts nowhere.
 */
export function sessionCounts(ids: string[], states: Record<string, SessionCardState | undefined>): SessionCounts {
  const of = (set: ReadonlySet<SessionCardState>) => ids.filter((id) => !!states[id] && set.has(states[id]!));
  return {
    running: of(RUNNING).length,
    queued: of(QUEUED).length,
    needs: of(NEEDS_USER),
    failed: of(WENT_WRONG).length,
  };
}

/**
 * The counts after the tasks', each separated from the last, and the probes that tell them each session's state. A
 * deeper session asking about its PR counts under "needs you" too, once: the chat's PR inbox knows it and this line
 * reads only the sessions the chat started itself.
 */
function useChatCounts(chatId: string) {
  const ids = useStartedBy(chatId);
  const pressed = useTasksTabPressed(chatId);
  const [states, onState] = useSessionStates();
  const line = usePrLine(chatId);
  const { running, queued, needs: started, failed } = sessionCounts(ids, states);
  const needs = [...new Set([...started, ...line.asking])];
  const open = () => toggleTasksPane(chatId);
  const opensTasks = (key: string, label: string) => (
    <button key={key} className="tasks-count" title="View sessions" aria-pressed={pressed} onClick={open}>
      {label}
    </button>
  );
  const counts = [
    running > 0 && opensTasks('running', sessionsRunningLabel(running)),
    queued > 0 && opensTasks('queued', sessionsQueuedLabel(queued)),
    needs.length > 0 && (
      // Stay in this window; ⌥-click opens a split, as a session's card does.
      <button
        key="needs"
        className="tasks-count waiting"
        title="Open the session waiting for you"
        onClick={(e) => openChatFrom(e, needs[0], { newWindow: false })}
      >
        {sessionsWaitingLabel(needs.length)}
      </button>
    ),
    failed > 0 && opensTasks('failed', sessionsFailedLabel(failed)),
  ].filter((count): count is ReactElement => !!count);
  const probes = ids.map((id) => <SessionStateProbe key={id} chatId={id} onState={onState} />);
  return { counts, probes };
}

const Separator = () => (
  <span className="tasks-count-sep" aria-hidden>
    ·
  </span>
);

const separated = (counts: ReactElement[], leading = false) =>
  counts.map((count, i) => (
    <Fragment key={count.key}>
      {(leading || i > 0) && <Separator />}
      {count}
    </Fragment>
  ));

/** The status line after a turn: the tasks count, then the chat's sessions. */
export function StatusCounts({ chatId }: { chatId: string }) {
  const { counts, probes } = useChatCounts(chatId);
  return (
    <>
      {probes}
      <TasksStatusRow chatId={chatId} extra={counts.length ? separated(counts) : null} />
    </>
  );
}

/** The same counts after the running turn's clock, in its one line: a session's question can't wait for the turn to end. */
export function InlineCounts({ chatId }: { chatId: string }) {
  const { counts, probes } = useChatCounts(chatId);
  return (
    <>
      {probes}
      <InlineTasksCount chatId={chatId} />
      {counts.length > 0 && <span className="tasks-count-inline">{separated(counts, true)}</span>}
    </>
  );
}
