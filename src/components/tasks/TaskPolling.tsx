// Keeps a Codex or ACP chat's background tasks fresh: renders nothing, polls while a turn runs, tasks run (as listed here or
// counted by main), the tasks tab is open, or a recent turn holds an agent (the latest turn, a command) still marked
// running: a chat reopened after a restart has no task list until it is read once, and a command its turn left running
// becomes a background terminal only once that turn ends (#1940).

/** How many of a chat's latest turns are looked at for an agent still running. */
const RECENT_TURNS = 5;
import { useStore } from '../../store/core';
import { useTaskPolling } from '../../store/agentWiring';
import { agentRunsOfTurn } from '../../lib/findAgentRun';
import { isRunningTask } from '../../lib/tasks';
import { useChatTasks } from './TaskList';
import { useSessions } from '../../store/session/useSession';
import { mainAdapterWork } from '../../store/backgroundTasks';

export function TaskPolling({ chatId }: { chatId: string }) {
  const turnRunning = useStore((s) => s.runtime[chatId]?.turns.some((t) => t.status === 'inProgress') ?? false);
  const paneOpen = useStore(
    (s) => s.diffPanel.open && s.paneTabs.some((t) => t.kind === 'tasks' && t.id === s.paneActive && t.threadId === chatId),
  );
  const agentRunning = useStore((s) =>
    (s.runtime[chatId]?.turns ?? []).slice(-RECENT_TURNS).some((t) => agentRunsOfTurn(t).some((run) => run.status === 'running')),
  );
  // the latest turn's: a command an earlier turn left running is a task by the time a later turn starts
  const commandRunning = useStore(
    (s) =>
      s.runtime[chatId]?.turns
        .at(-1)
        ?.items.some((i) => i.type === 'commandExecution' && (i as { status?: unknown }).status === 'inProgress') ?? false,
  );
  const running = useChatTasks(chatId).some(isRunningTask);
  // main counts work this window never listed (it was reloaded, or opened after the work started): list it
  const mainWork = useSessions((s) => mainAdapterWork(chatId, s.sessions[chatId]?.backgroundWork) > 0);
  useTaskPolling(chatId, turnRunning || paneOpen || running || agentRunning || commandRunning || mainWork);
  return null;
}
