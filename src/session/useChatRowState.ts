// A chat's row state (session/chatRowState.ts) read live from the stores, for every place that shows it: the sidebar row's
// dot and the live session card a parent chat shows for a session it started.
import type { SideSessionChild } from '../../shared/orchestration';
import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store/core';
import { chatOf } from '../store/chats';
import { chatAgentTabs } from '../lib/agentTabs';
import { useWrapUpAsk } from '../lib/sideSessions';
import type { Elsewhere, Thread } from '../store/types';
import { ensureSession, refreshSession, useSession, useSessionLoaded, useSessions } from '../store/session/useSession';
import { useAdapterTasks } from '../store/backgroundTasks';
import { chatRowStatus, rowRuntime, type ChatRowState } from './chatRowState';

/** The main-owned turn phase, or null until this window has received its snapshot. */
export function useChatTurn(chatId: string | undefined): ReturnType<typeof useSession>['turn'] | null {
  const session = useSession(chatId);
  const loaded = useSessionLoaded(chatId);
  return loaded ? session.turn : null;
}

export type TurnPhase = ReturnType<typeof useSession>['turn'];
export const retryChatState = refreshSession;

/**
 * The chat's state, with where else it runs; null while the window doesn't know the chat (not listed yet, or gone).
 * `own`: the chat's record when the caller has it (a row of a list the store may not hold, such as search results).
 * Each store is read as the narrow part the state needs and the state is derived in the selector, so a streamed delta
 * (a new `turns` array, a session patch that changes no status) re-renders the row only when its state changes.
 */
export function useChatRowState(
  chatId: string,
  linked?: SideSessionChild,
  own?: Thread,
): { state: ChatRowState; elsewhere: Elsewhere | undefined; backgroundRunning: boolean; attentionCount: number } | null {
  // the caller's record when it has one; the store's otherwise
  const thread = useStore((s) => own ?? s.threads[chatId]);
  useEffect(() => {
    ensureSession(chatId);
  }, [chatId]);
  const runtime = useStore(useShallow((s) => rowRuntime(s.runtime[chatId])));
  const requests = useStore(useShallow((s) => s.pending.filter((p) => p.threadId === chatId)));
  const adapterTasks = useAdapterTasks(chatId);
  const elsewhere = useStore((s) => s.elsewhere[chatId]);
  const unread = useStore((s) => !!s.unread[chatId]);
  const wrapUp = useWrapUpAsk(chatId);
  const handoff = useStore((s) => !!chatAgentTabs(s.agentTabs, chatId, chatOf)?.tabs.some((t) => t.signin));
  // the selector closes over this render's other reads, so it reruns when they change and on every session patch,
  // and the component renders again only when the derived pair does
  const row = useSessions(
    useShallow((s) => {
      if (!thread) return null;
      return chatRowStatus({
        thread,
        session: s.sessions[chatId],
        runtime,
        requests,
        adapterTasks,
        elsewhere,
        unread,
        linked,
        asks: wrapUp || handoff,
      });
    }),
  );
  return row && { ...row, elsewhere };
}
