// The family heads a default sidebar fold must reach: open panes, running work and requests for input on every harness.
import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store/core';
import type { Thread } from '../../store/types';
import { visibleChats } from '../../store/split';
import { ensureSession, useSessions } from '../../store/session/useSession';
import { adapterTasksOf, useAdapterTaskActivity } from '../../store/backgroundTasks';
import { chatRowStatus, rowRuntime } from '../../session/chatRowState';
import { useSidebarLineage } from '../../session/harness/claude/desktopLineage';
import { familiesOf } from '../../lib/sidebarFamilyIndex';

/** Only the owning list passes its roots; duplicate Pinned/Recents copies need not unfold too. */
export function useRequiredChats(roots: readonly Thread[], activeThread: string | null): ReadonlySet<string> {
  const lineage = useSidebarLineage();
  const threads = useStore((s) => s.threads);
  const listed = useStore((s) => s.threadOrder);
  const momo = useStore((s) => s.momoChats);
  const families = familiesOf(lineage, listed, threads, momo, false);
  const members = roots.flatMap((root) => [
    { thread: root, root: root.id },
    ...(families.descendants.get(root.id) ?? []).map((id) => ({ thread: threads[id], root: root.id })),
  ]);
  const ids = new Set(members.map(({ thread }) => thread.id));
  const open = useStore(useShallow((s) => visibleChats(s).filter((id) => ids.has(id))));
  // Hidden rows cannot load themselves. Reuse the snapshot owner/coalescer, once per membership change,
  // so a reloaded window also discovers work that started while it was closed. JSON preserves opaque ids.
  const key = JSON.stringify([...ids]);
  useEffect(() => {
    for (const id of JSON.parse(key) as string[]) ensureSession(id);
  }, [key]);
  const runtimes = useStore(useShallow((s) => members.map(({ thread }) => rowRuntime(s.runtime[thread.id]))));
  const requests = useStore(useShallow((s) => s.pending.filter((p) => ids.has(p.threadId as string))));
  const elsewheres = useStore(useShallow((s) => members.map(({ thread }) => s.elsewhere[thread.id])));
  useAdapterTaskActivity([...ids]);
  // Derive just the required roots in the selector. Streaming text or task progress that changes no
  // visibility leaves the set shallow-equal and does not render the list again.
  return useSessions(
    useShallow((all) => {
      const required = new Set<string>();
      members.forEach(({ thread, root }, at) => {
        const { state, backgroundRunning } = chatRowStatus({
          thread,
          session: all.sessions[thread.id],
          runtime: runtimes[at],
          requests,
          adapterTasks: adapterTasksOf(thread.id),
          elsewhere: elsewheres[at],
          unread: false,
        });
        if (
          thread.id === activeThread ||
          open.includes(thread.id) ||
          backgroundRunning ||
          all.sessions[thread.id]?.runningElsewhere ||
          elsewheres[at]?.running ||
          state === 'working' ||
          state === 'approval' ||
          state === 'input'
        )
          required.add(root);
      });
      return required;
    }),
  );
}
