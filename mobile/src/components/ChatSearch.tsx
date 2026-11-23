// The Chats page's search, opened from the search circle at its bottom left (Claude's place for it) and shown as a field at the top of the list.
import { createContext, createElement, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/** `listed` is whether a chat list is on the page: without one there is nothing to search, so nothing offers it. */
export type ChatSearch = { open: boolean; show: () => void; hide: () => void; listed: boolean; list: () => () => void };
/** Outside a provider nothing can open the search, so it stays closed. */
const nothing = () => undefined;
const Closed: ChatSearch = { open: false, show: nothing, hide: nothing, listed: false, list: () => nothing };
const Context = createContext<ChatSearch>(Closed);

/** Holds whether the search is open for the page below it; the list reads it, the page's search circle opens it. */
export function ChatSearchProvider({ children }: { children: (search: ChatSearch) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState(0);
  const list = useCallback(() => {
    setLists((n) => n + 1);
    return () => setLists((n) => n - 1);
  }, []);
  const listed = lists > 0;
  // a search left open when the list goes away (the Mac drops) is closed with it: its circle is gone, so nothing could close it
  if (open && !listed) setOpen(false);
  const value: ChatSearch = { open: open && listed, show: () => setOpen(true), hide: () => setOpen(false), listed, list };
  return createElement(Context.Provider, { value }, children(value));
}

/** Outside a provider the search is closed and cannot open. */
export const useChatSearch = () => useContext(Context);

/** The list says it is on the page while it is mounted, so the page and the drawer offer its search. */
export function useSearchableList() {
  const search = useContext(Context);
  useEffect(() => search.list(), [search.list]);
  return search;
}
