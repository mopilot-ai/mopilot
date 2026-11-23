// Which Host holds a chat, as main's ownership file says (chatOwner in electron/host/machines.cjs): read when the chat changes and again on `refresh` (after a continue), and only while Host exists for the account.
import { useCallback, useEffect, useRef, useState } from 'react';
import { native } from './native';
import { ignoring } from './ignored';
import { useHostAccess } from './host';
import { reloadHostChats } from './hostChats';

/** Every reader of an owner on screen (the chip, the summary's machine chip): a continue changes the owner for all of them, so each reads again. */
const readers = new Set<() => void>();

/** The chat's owner Host id; this Mac until main has answered (or for a chat no Host claimed). */
export function useChatOwner(chatId: string | null): { ownerId: string; known: boolean; refresh: () => void } {
  const allowed = useHostAccess();
  const [read, setRead] = useState<{ chatId: string; hostId: string } | null>(null);
  // the latest read wins: an answer for a chat that was left, or one a newer read has overtaken, is dropped
  const latest = useRef(0);
  const load = useCallback(() => {
    if (!allowed || !chatId) return;
    const mine = ++latest.current;
    native.host
      .owner(chatId)
      .then((o) => mine === latest.current && setRead({ chatId, hostId: o?.hostId ?? 'local' }), ignoring("read the chat's host"));
  }, [allowed, chatId]);
  useEffect(() => {
    load();
    readers.add(load);
    return () => {
      latest.current++;
      readers.delete(load);
    };
  }, [load]);
  const refresh = useCallback(() => {
    [...readers].forEach((read) => read());
    // a continue moved the chat: every panel that tells a folder on a machine from one here reads again
    void reloadHostChats();
  }, []);
  const fresh = read && read.chatId === chatId ? read : null;
  // a chat with no id yet is this Mac's; a chat main has not answered for is unknown, not assumed local
  return { ownerId: fresh?.hostId ?? 'local', known: !!fresh || !chatId || !allowed, refresh };
}
