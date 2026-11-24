// The rows of MoMo's Sessions pane read live (M6): the sidebar's own chat list (roots, no MoMo chat) with each chat's shared status, harness and machine, re-derived when any of them changes. Chats are found by their stable MoPilot chat id; nothing here names a harness.
import { useEffect, useMemo } from 'react';
import { useStore, threadTitle } from '../../../store/core';
import { chatHarnessLabel } from '../../../store/chats';
import { ensureSession, useSessions } from '../../../store/session/useSession';
import { adapterTasksOf, useAdapterTasksRevision } from '../../../store/backgroundTasks';
import { familiesOf } from '../../../lib/sidebarFamilyIndex';
import { machineOfChat, useHostChats } from '../../../lib/hostChats';
import { useHostMachines } from '../../../lib/hostMachines';
import { useFamilyLineage } from '../../../session/harness/claude/desktopLineage';
import { sessionRows, type SessionRow } from './sessionRows';

const NONE: readonly string[] = [];

/** The chats with something open, and none at all while `show` is off (nothing is read then). */
export function useSessionRows(show: boolean): SessionRow[] {
  const lineage = useFamilyLineage();
  const threads = useStore((s) => s.threads);
  const initialTitles = useStore((s) => s.chatInitialTitles);
  const listed = useStore((s) => s.threadOrder);
  const momoChats = useStore((s) => s.momoChats);
  const runtime = useStore((s) => s.runtime);
  const pending = useStore((s) => s.pending);
  const elsewhere = useStore((s) => s.elsewhere);
  const unread = useStore((s) => s.unread);
  const sessions = useSessions((s) => s.sessions);
  const tasks = useAdapterTasksRevision();
  const hostChats = useHostChats();
  const { machines } = useHostMachines();
  // the sidebar's roots (cached: the same array until the list changes); a chat this window never opened has no session yet, so its card is asked for
  const roots = show ? familiesOf(lineage, listed, threads, momoChats, true).roots : NONE;
  useEffect(() => {
    for (const id of roots) ensureSession(id);
  }, [roots]);
  return useMemo(() => {
    // a change of the adapter-task revision re-reads adapterTasksOf below
    void tasks;
    if (!show) return [];
    return sessionRows({
      ids: roots,
      inputs: (id) =>
        threads[id]
          ? {
              thread: threads[id],
              session: sessions[id],
              runtime: runtime[id],
              requests: pending.filter((p) => p.threadId === id),
              adapterTasks: adapterTasksOf(id),
              elsewhere: elsewhere[id],
              unread: !!unread[id],
            }
          : null,
      title: (id) => threadTitle(threads[id], initialTitles),
      harness: chatHarnessLabel,
      place: (id) => {
        const machine = machineOfChat(hostChats, id);
        if (!machine) return null;
        const row = machines.find((m) => m.id === machine);
        return { name: row?.name ?? machine, away: row?.status === 'offline' };
      },
    });
  }, [show, roots, threads, initialTitles, runtime, pending, elsewhere, unread, sessions, tasks, hostChats, machines]);
}
