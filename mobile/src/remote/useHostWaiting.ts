// The chats a Host holds a waiting card for, as Home reads them (#4593): the phone's own paths know it with the Mac asleep, and the list is kept current while Home is open.
import { useMemo } from 'react';
import type { MobileRuntime } from '../contracts';
import { appChatId } from '../../../shared/host/chatIds.mjs';
import { heldByMachine } from './hostChat';
import { useDirect, useDirectWatch } from './useDirect';

/** How often Home reads the cards (slower than the machine page's own read). */
export const HOME_WATCH_MS = 4000;

/** Chat id to the machine whose Host waits on it. */
export function useHostWaiting(runtime: MobileRuntime, home = true): Map<string, string> {
  const direct = useDirect(runtime);
  // the cards are read only while the list is on screen: a thread or Settings has its own reads
  useDirectWatch(home ? runtime : undefined, HOME_WATCH_MS);
  return useMemo(() => {
    const byChat = new Map<string, string>();
    if (!direct) return byChat;
    for (const { machineId } of direct.facts.records)
      for (const shown of direct.cards(machineId)) {
        if (shown.state.kind !== 'waiting') continue;
        // a Claude Code or Codex chat is named one way by the Host and another in the Mac's list: the row is found by either
        byChat.set(shown.card.chatId, machineId);
        byChat.set(appChatId(shown.card.chatId), machineId);
      }
    return byChat;
  }, [direct]);
}

/** The chat list with a chat a Host waits on drawn as waiting (so it sits under Needs input), whichever the Mac's list says. */
export function withHostWaiting<T extends { id: string; state?: string; hostId?: string }>(
  chats: T[] | null,
  waiting: Map<string, string>,
): (T & { hostCard?: true })[] | null {
  if (!chats || waiting.size === 0) return chats;
  return chats.map((c) => {
    const machine = waiting.get(c.id);
    return machine && c.state !== 'waiting' ? { ...c, state: 'waiting', hostId: c.hostId ?? machine, hostCard: true } : c;
  });
}

/**
 * What a tap on a chat does: for a chat a Host waits on it opens that machine's page (where the card is answered), otherwise `otherwise` as before.
 * A chat the Mac itself lists (`listed`) as waiting keeps its own way, so a Host card never hides the Mac's request or the chat; so does a chat
 * that goes through the machine itself (`chatCarriesCards`), which draws its cards in the thread.
 */
export const viaHost =
  (
    waiting: Map<string, string>,
    openMachine: (machineId: string) => void,
    otherwise: (chatId: string) => void,
    listed: { id: string; state?: string }[] | null = null,
    chatCarriesCards: (chatId: string) => boolean = () => false,
  ) =>
  (chatId: string) => {
    const machine = waiting.get(chatId);
    if (machine && !chatCarriesCards(chatId) && listed?.find((c) => c.id === chatId)?.state !== 'waiting') openMachine(machine);
    else otherwise(chatId);
  };

/**
 * Whether a chat opens through the machine itself, so its cards are answered in the thread: any machine chat while the Mac is away and the phone follows
 * machine chats, and with the Mac there a chat only the machine holds (the rule a thread routes by, #4653). `machineId` is the machine the chat waits on.
 */
export const carriesCards = (macOnline: boolean, runtime: MobileRuntime, machineId?: string, chatId?: string) =>
  runtime.direct?.chat?.enabled() === true && (!macOnline || heldByMachine(runtime.direct.chat, machineId, chatId));

/**
 * What a tap on a Home row does, in one place: `open` for the row itself and `review` for its quick review (where one can be answered now).
 * A chat that goes through its machine opens as a chat either way, since its card is drawn and answered in the thread; any other Host card opens the machine's page.
 */
export function homeTaps(
  waiting: Map<string, string>,
  macOnline: boolean,
  runtime: MobileRuntime,
  chats: { id: string; state?: string }[] | null,
  openMachine: (machineId: string) => void,
  openChat: (chatId: string) => void,
  openReview: (chatId: string) => void,
) {
  // a request the Mac itself lists as waiting is answered in the Mac's review, as before, even when a Host also holds a card on it
  const carried = (id: string) =>
    carriesCards(macOnline, runtime, waiting.get(id), id) && !(macOnline && chats?.find((c) => c.id === id)?.state === 'waiting');
  return {
    open: viaHost(waiting, openMachine, openChat, chats, carried),
    review: viaHost(waiting, openMachine, (id) => (carried(id) ? openChat(id) : openReview(id)), chats, carried),
  };
}

/** A chat this phone started on a machine, as the list draws it. */
type Started = { chatId: string; machineId: string; title: string; at: number };

/**
 * The chat list with the chats this phone started on a machine added where the Mac has not listed them (a chat only the machine holds has no row on the
 * Mac, awake or away): each as a row of its own, idle until a card says it waits. The Mac's own row of a chat, once it has one, is the one that stands.
 */
export function withStarted<T extends { id: string; state?: string; hostId?: string; title?: string; at?: number }>(
  chats: T[] | null,
  started: Started[],
): T[] | null {
  const missing = started.filter((c) => !chats?.some((m) => m.id === c.chatId));
  if (!missing.length) return chats;
  const rows = missing.map((c) => ({ id: c.chatId, title: c.title, state: 'idle', hostId: c.machineId, at: c.at }) as unknown as T);
  return [...(chats ?? []), ...rows];
}

/** The chats this phone started on its machines, read again whenever the direct paths change. */
export function useStartedChats(runtime: MobileRuntime): Started[] {
  const direct = useDirect(runtime);
  return useMemo(() => {
    const paths = runtime.direct;
    // a runtime whose direct paths hold no chats of their own has none started
    if (!direct || !paths?.chat) return [];
    return paths.phones.records().flatMap((r: { machineId: string }) => paths.chat.startedOn(r.machineId));
  }, [direct, runtime.direct]);
}
