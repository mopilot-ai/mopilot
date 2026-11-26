// The Chats tab's list: read from the computer, kept for the pair it came from so it is still there (marked as the last one read) while the computer is away or the list is read again.
import { useCallback, useEffect, useRef, useState, type MutableRefObject, type SetStateAction } from 'react';
import type { MobileRuntime } from './contracts';
import type { ChatListItem } from './components/ChatRow';
import { CHAT_PAGE, chatPage } from './chatPages';
import { useMoreChats } from './useMoreChats';
import { mark } from './launchTrace';
import type { ListCache } from './presentation/listCache';

/** The Mac's `chats.changed` events of a burst are answered by one read this long after the first. */
export const LIST_REREAD_MS = 300;
/** The most chats one read of the list asks for (the Mac's own limit). */
const MAX_LIST_READ = 200;

/** The computer the connection was last up to: kept while it is away, for the one-tap reconnect and for the chats' keys. */
export function useLastPair(selected: string | null) {
  const last = useRef<string | null>(null);
  if (selected) last.current = selected;
  return last;
}

/** The computer a chat belongs to: the one connected, else the last one used, else the one being waited for, else the only one paired. A chat opened at launch with that computer away is kept under the same key it was saved under. */
export function chatPairOf(
  state: { selectedPair: string | null; pairs: { pairId: string }[]; reconnect?: { pairId: string } | null },
  lastPair: string | null,
) {
  return state.selectedPair ?? lastPair ?? state.reconnect?.pairId ?? (state.pairs.length === 1 ? state.pairs[0].pairId : null);
}

/** Whose list this is: the account and the computer. Before the first connection the computer being waited for, or the one paired, is the one the list will be read from, so its saved list can paint at launch. */
export function chatListKey(
  state: { user?: { id?: string } | null; selectedPair: string | null; pairs: { pairId: string }[]; reconnect?: { pairId: string } | null },
  lastPair: string | null,
) {
  return JSON.stringify([state.user?.id, chatPairOf(state, lastPair)]);
}

/** The same chats in the same order, as the Mac told them (they are plain data). */
export function sameChats(a: ChatListItem[], b: ChatListItem[]) {
  return a.length === b.length && a.every((chat, i) => chat === b[i] || JSON.stringify(chat) === JSON.stringify(b[i]));
}

export function useChatList(o: {
  runtime: MobileRuntime;
  /** The screen's lifetime and the count of list reads; a change in either leaves an answer that was on its way unused. */
  lifetime: MutableRefObject<number>;
  reads: MutableRefObject<number>;
  /** Who the answer is for (account, computer and connection): an answer for another is dropped. */
  owner: () => string;
  /** Whose list this is (account and computer): what was read for another is never shown. */
  key: string;
  setError: (message: string | null) => void;
  /** The sealed last list per account and computer, opening: shown at once, until the computer's own list replaces it in place. */
  lists?: Promise<ListCache | null>;
}) {
  const [held, setHeld] = useState<{ key: string; chats: ChatListItem[] } | null>(null);
  /** Whether the list shown was read since the computer was last away: until the first page lands again it is the last one read. */
  const [fresh, setFresh] = useState(false);
  const keyNow = useRef(o.key);
  keyNow.current = o.key;
  // read by the reads in flight, so the one that starts a read does not change with every render
  const ownerNow = useRef(o.owner);
  ownerNow.current = o.owner;
  const chats = held && held.key === o.key ? held.chats : null;
  const setChats = useCallback((next: SetStateAction<ChatListItem[] | null>) => {
    setHeld((old) => {
      const was = old && old.key === keyNow.current ? old.chats : null;
      const value = typeof next === 'function' ? next(was) : next;
      // a read that finds the list as it was changes nothing: the screens that show it are not drawn again for it
      if (old && was && value && sameChats(was, value)) return old;
      return value && { key: keyNow.current, chats: value };
    });
  }, []);
  const [cache, setCache] = useState<ListCache | null>(null);
  useEffect(() => {
    let live = true;
    o.lists?.then(
      (opened) => live && setCache(opened),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [o.lists]);
  useEffect(() => {
    if (chats) mark('list-shown');
  }, [chats]);
  // the last list read for this key paints from disk; it never replaces one already read or held for the key
  useEffect(() => {
    if (!cache) return;
    let live = true;
    const key = o.key;
    cache
      .load(key)
      .then((saved) => {
        if (!live || !saved.length) return;
        mark('list-cached');
        setHeld((old) => (old && old.key === key ? old : { key, chats: saved }));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [cache, o.key]);
  // what the computer answered is what is kept for next launch
  useEffect(() => {
    if (cache && fresh && chats) void cache.save(keyNow.current, chats).catch(() => undefined);
  }, [cache, fresh, chats]);
  const { more, loading, setMore, setLoading, load } = useMoreChats({
    runtime: o.runtime,
    lifetime: o.lifetime,
    reads: o.reads,
    owner: o.owner,
    setChats,
    setError: o.setError,
  });
  const shownCount = useRef(0);
  shownCount.current = chats?.length ?? 0;
  /** Reads the first page, or (not clearing) as many chats as are shown, so the pages loaded stay; the list shown until it arrives is the last one read for this computer. */
  const read = useCallback(
    async (clear: boolean, owner: string, limit = clear ? CHAT_PAGE : Math.min(MAX_LIST_READ, Math.max(CHAT_PAGE, shownCount.current))) => {
      const life = o.lifetime.current;
      const id = ++o.reads.current;
      const current = () =>
        life === o.lifetime.current && id === o.reads.current && owner === ownerNow.current() && o.runtime.snapshot().phase === 'online';
      o.setError(null);
      setLoading(false);
      if (clear) {
        setMore(false);
        setFresh(false);
      }
      try {
        mark('list-sent');
        const page = chatPage(await o.runtime.request('chats.recent', { limit }));
        mark('list-answer');
        if (current()) {
          setChats(page.chats);
          setMore(page.more);
          setFresh(true);
        }
      } catch (e: unknown) {
        if (current()) o.setError(e instanceof Error ? e.message : String(e));
      }
    },
    [o.runtime, o.lifetime, o.reads, o.setError, setChats, setLoading, setMore],
  );
  // the Mac says its list changed (a new chat, a title, a state, a harness's list that landed late): read it again, once for a burst, in place
  const ownerRead = useRef(o.owner);
  ownerRead.current = o.owner;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // (a runtime without events, as some test doubles are, has nothing to hear)
    const off = o.runtime.onEvent?.((event) => {
      if ((event as { ev?: unknown }).ev !== 'chats.changed' || timer !== null || o.runtime.snapshot().phase !== 'online') return;
      timer = setTimeout(() => {
        timer = null;
        void read(false, ownerRead.current());
      }, LIST_REREAD_MS);
    });
    return () => {
      off?.();
      if (timer !== null) clearTimeout(timer);
    };
  }, [o.runtime, read]);
  /** The computer is away: the list stays as the last one read, or goes when it cannot be (another account, nothing connected before). */
  const leave = useCallback(
    (keep: boolean) => {
      setMore(false);
      setLoading(false);
      setFresh(false);
      if (!keep) setHeld(null);
    },
    [setLoading, setMore],
  );
  return { chats, fresh, more, loading, read, leave, loadMore: load, cache };
}
