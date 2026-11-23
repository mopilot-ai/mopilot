// Restore the current window's remote side panes after a renderer reload, using main's live child bindings.
import { sideChatUuid } from '../../shared/host/sideChats.mjs';
import { ignoring, noteIgnored } from '../lib/ignored';
import { get, set, useStore } from './core';
import { openHostSideChat } from './hostSideChat';
import { openPaneTab } from './panes';
import { runtime } from './runtime';
import { focusedChat } from './split';
import type { AppState } from './state';

const KEY = 'mopilot:remoteSidePanes';
type Binding = { sourceChatId: string; threadId: string };

function bindings(s: AppState): Binding[] {
  const focused = focusedChat(s);
  // The focused chat's tabs are live. Its last parked snapshot can still hold a tab just closed here.
  const parked = Object.entries(s.chatPanes).flatMap(([chatId, pane]) => (chatId === focused ? [] : pane.tabs));
  const tabs = [...s.paneTabs, ...parked];
  const children = new Map<string, Binding>();
  for (const { kind, threadId, sourceChatId } of tabs)
    if (kind === 'chat' && threadId && sourceChatId && sideChatUuid(threadId)) children.set(threadId, { threadId, sourceChatId });
  return [...children.values()];
}

function savedBindings(storage: Storage): Binding[] {
  const rows = JSON.parse(storage.getItem(KEY) ?? '[]');
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => typeof row?.sourceChatId === 'string' && typeof row.threadId === 'string' && sideChatUuid(row.threadId));
}

export async function restoreRemoteSidePanes() {
  let storage: Storage | undefined;
  try {
    storage = window.sessionStorage;
  } catch (error) {
    noteIgnored('read this window’s temporary side chats', error);
  }
  if (!storage) return;
  const save = (s: AppState) => {
    try {
      storage.setItem(KEY, JSON.stringify(bindings(s)));
    } catch (error) {
      noteIgnored('remember this window’s temporary side chats', error);
    }
  };
  try {
    for (const { sourceChatId, threadId } of savedBindings(storage)) {
      const opened = await openHostSideChat(sourceChatId, threadId).catch(ignoring('restore a temporary side chat'));
      if (!opened || bindings(get()).some((row) => row.threadId === threadId)) continue;
      opened.publish();
      set((s) => ({ threads: { ...s.threads, [threadId]: opened.thread } }));
      openPaneTab('chat', { sourceChatId, threadId });
      void runtime().openAcpThread(threadId).catch(ignoring('read the side chat’s history'));
    }
  } catch (error) {
    noteIgnored('restore this window’s temporary side chats', error);
  }
  useStore.subscribe((s, prev) => {
    if (s.paneTabs !== prev.paneTabs || s.chatPanes !== prev.chatPanes) save(s);
  });
  save(get());
}
