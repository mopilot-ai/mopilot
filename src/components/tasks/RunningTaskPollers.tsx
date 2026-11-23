// Keeps polling every listed chat with a Codex or ACP task still running, open or not, so the sidebar's working dot and tasks marker settle when the task does.
import { useStore } from '../../store/core';
import { chatsWithAdapterWork, useAdapterTasksRevision } from '../../store/backgroundTasks';
import { TaskPolling } from './TaskPolling';

export function RunningTaskPollers() {
  useAdapterTasksRevision();
  const working = chatsWithAdapterWork();
  // an archived or removed chat leaves the list, and its tasks with it
  const listed = useStore((s) => working.filter((id) => s.threads[id]).join('\n'));
  if (!listed) return null;
  return (
    <>
      {listed.split('\n').map((id) => (
        <TaskPolling key={id} chatId={id} />
      ))}
    </>
  );
}
