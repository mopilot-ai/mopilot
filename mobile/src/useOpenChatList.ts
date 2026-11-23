// What the chats list does when a chat is opened: it is read again each time the open chat changes (a card answered inside leaves its row, and a parent's amber, stale), and a chat from beyond the loaded pages (a link, a sub-session, a push tap) names itself: the pages after the ones shown are read, one at a time, until its row is there.
import { useEffect, useRef } from 'react';
import type { ChatListItem } from './components/ChatRow';

/** The most pages read for one chat's title; a chat the Mac does not list stops here, or earlier when the Mac says there are no more. */
export const TITLE_PAGES = 10;

export function useOpenChatList(o: {
  /** The open chat, if one is open. */
  chat: string | null | undefined;
  chats: ChatListItem[] | null;
  /** The Mac has chats after the ones shown. */
  more: boolean;
  /** A page is on its way. */
  loading: boolean;
  loadMore: (shown: ChatListItem[]) => void;
  /** The computer is connected, so the list can be read. */
  online: boolean;
  /** Reads the list again, keeping the pages loaded. */
  reread: () => void;
}) {
  const read = useRef({ chat: '', pages: 0 });
  const { chat, chats, more, loading, loadMore, online, reread } = o;
  const last = useRef(chat);
  useEffect(() => {
    if (last.current === chat) return;
    last.current = chat;
    if (online) reread();
  }, [chat, online, reread]);
  useEffect(() => {
    if (!chat || !chats || !more || loading || chats.some((c) => c.id === chat)) return;
    if (read.current.chat !== chat) read.current = { chat, pages: 0 };
    if (read.current.pages >= TITLE_PAGES) return;
    read.current.pages += 1;
    loadMore(chats);
  }, [chat, chats, more, loading, loadMore]);
}
