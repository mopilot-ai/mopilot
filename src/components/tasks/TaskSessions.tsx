// The Background tasks tab's sessions: the chats a chat started, on any harness, as their live cards (thread/SessionCard.tsx),
// grouped by whether they need the user, went wrong, still run, or have ended, ahead of the chat's commands and agents.
import { useOrchestration } from '../../lib/sideSessions';
import { NEEDS_USER, SessionCard, WENT_WRONG, type SessionCardState } from '../thread/SessionCard';
import { useSessionStates } from '../thread/sessionStates';
import type { OrchestrationView } from '../../../shared/orchestration';

type Group = 'needs' | 'failed' | 'running' | 'finished' | 'archived';
const GROUPS: [Group, string][] = [
  ['needs', 'Needs you'],
  ['failed', 'Failed sessions'],
  ['running', 'Running sessions'],
  ['finished', 'Finished sessions'],
];

/**
 * Where a session's card goes; one whose state the window doesn't know yet counts as running. An archived one is put
 * away, as a cleared task is: its card stays mounted out of sight, so it still reports a state it takes next.
 */
export function sessionGroup(state: SessionCardState | undefined): Group {
  if (state && NEEDS_USER.has(state)) return 'needs';
  if (state && WENT_WRONG.has(state)) return 'failed';
  if (state === 'done' || state === 'idle') return 'finished';
  if (state === 'archived') return 'archived';
  return 'running';
}

/** The chats a chat started that are still linked to it, oldest first. */
export function startedBy(view: OrchestrationView, chatId: string): string[] {
  return Object.entries(view.children)
    .filter(([, c]) => c.parentId === chatId && !c.detached)
    .sort(([, a], [, b]) => a.createdAt - b.createdAt)
    .map(([id]) => id);
}

/** The chat's sessions, read live from main's linked sessions. */
export const useStartedBy = (chatId: string): string[] => startedBy(useOrchestration(), chatId);

export function TaskSessions({ chatId }: { chatId: string }) {
  const view = useOrchestration();
  const ids = useStartedBy(chatId);
  // each card's state as it reports it, which decides its group
  const [states, onState] = useSessionStates();
  const card = (id: string) => (
    <SessionCard
      key={id}
      chatId={id}
      parentId={chatId}
      title={view.children[id].title || view.children[id].name}
      fallback=""
      onState={onState}
    />
  );
  const archived = ids.filter((id) => sessionGroup(states[id]) === 'archived');
  return (
    <>
      {GROUPS.map(([group, label]) => {
        const shown = ids.filter((id) => sessionGroup(states[id]) === group);
        if (!shown.length) return null;
        return (
          <section key={group} className="tasks-section" data-group={group}>
            <h3 className="tasks-section-head">
              {label} · {shown.length}
            </h3>
            <div className="task-sessions">{shown.map(card)}</div>
          </section>
        );
      })}
      {archived.length > 0 && <div hidden>{archived.map(card)}</div>}
    </>
  );
}
