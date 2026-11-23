// "Load more chats": the page after the chats shown, one at a time; its answer is dropped when a refresh, another computer or a lost connection comes first.
import { useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { MobileRuntime } from './contracts';
import type { ChatListItem } from './components/ChatRow';
import { appendChats, CHAT_PAGE, chatPage } from './chatPages';

export function useMoreChats(o: {
  runtime: MobileRuntime;
  /** The screen's lifetime and the count of list reads; a change in either leaves a page that was on its way unused. */
  lifetime: MutableRefObject<number>;
  reads: MutableRefObject<number>;
  owner: () => string;
  setChats: Dispatch<SetStateAction<ChatListItem[] | null>>;
  setError: (message: string | null) => void;
}) {
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  /** The read a page is on its way for; a second tap before the button redraws finds it and asks for nothing. */
  const paging = useRef(-1);
  async function load(shown: ChatListItem[]) {
    if (paging.current === o.reads.current) return;
    const life = o.lifetime.current;
    const read = o.reads.current;
    const key = o.owner();
    const current = () => life === o.lifetime.current && read === o.reads.current && key === o.owner();
    paging.current = read;
    o.setError(null);
    setLoading(true);
    try {
      const page = chatPage(await o.runtime.request('chats.recent', { limit: CHAT_PAGE, offset: shown.length }));
      if (current()) {
        o.setChats((now) => appendChats(now, page.chats));
        setMore(page.more);
      }
    } catch (e: unknown) {
      if (current()) o.setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (current()) {
        paging.current = -1;
        setLoading(false);
      }
    }
  }
  return { more, loading, setMore, setLoading, load };
}
