// Keeps the shared list of chats on machines (hostChats.ts) current: read again when the chat list changes and when the window takes focus (another window may have moved a chat).
import { useRef } from 'react';
import { useEffectOn, useWindowListener } from './effects';
import { useHostAccess } from './host';
import { reloadHostChats } from './hostChats';

/** Reads again when the list of chats changes (a chat another window or a phone started): mounted once, by the app. */
export function useReloadHostChatsOn(chatCount: number) {
  const allowed = useHostAccess();
  const first = useRef(true);
  useEffectOn([allowed, chatCount], () => {
    // the first read belongs to useHostChats
    if (first.current) first.current = false;
    else if (allowed) void reloadHostChats();
  });
  // a chat moved from another window changes no count here
  useWindowListener('focus', () => allowed && void reloadHostChats());
}
