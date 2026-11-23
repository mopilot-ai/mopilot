// The recent-chats list in pages: reading what the Mac answered for one page and joining it to the pages already shown.
import type { ChatListItem } from './components/ChatRow';
import { changesOf } from './presentation/chatRowParts';

/** Chats asked for at a time; the Mac tells whether another page follows. */
export const CHAT_PAGE = 50;

export type ChatPage = { chats: ChatListItem[]; more: boolean };

const ENDINGS = new Set(['finished', 'failed', 'stopped', 'lost']);

/** One page of chats.recent. `more` is true only when the Mac says so, so an older Mac that does not page never shows a "load more". */
export function chatPage(result: unknown, receivedAt = Date.now()): ChatPage {
  const chats = (result as { chats?: unknown } | null)?.chats;
  if (
    !Array.isArray(chats) ||
    !chats.every((chat: unknown) => chat && typeof chat === 'object' && typeof (chat as { id?: unknown }).id === 'string')
  )
    throw new Error('Could not read chats.');
  // the Mac's clock against this one (the Mac says what time it is with the list): a chat's time is read on this phone's clock, so "5 minutes ago" is right on a phone whose clock differs
  const macNow = (result as { now?: unknown }).now;
  const skew = typeof macNow === 'number' && Number.isFinite(macNow) ? receivedAt - macNow : 0;
  // `changes` is shown as numbers, so only two whole numbers are kept
  // a linked session names the chat that started it, which the list nests it under (an older computer names none)
  const rows = (chats as ChatListItem[]).map((chat) => {
    const { changes, parentId, ended, ...rest } = chat;
    const kept = changesOf(changes);
    const at = typeof rest.at === 'number' ? { at: rest.at + skew } : {};
    const parent = typeof parentId === 'string' && parentId && parentId !== rest.id ? { parentId } : {};
    const ending = typeof ended === 'string' && ENDINGS.has(ended) ? { ended } : {};
    return { ...rest, ...at, ...(kept ? { changes: kept } : {}), ...parent, ...ending };
  });
  return { chats: rows, more: (result as { more?: unknown }).more === true };
}

/** The next page after the chats shown (a list cleared meanwhile starts over from the page). A chat with new activity can move down a page while the list is open and then comes in twice: it keeps its first place and its newest data. */
export function appendChats(shown: ChatListItem[] | null, next: ChatListItem[]): ChatListItem[] {
  if (!shown) return next;
  const fresh = new Map(next.map((chat) => [chat.id, chat]));
  const seen = new Set(shown.map((chat) => chat.id));
  return [...shown.map((chat) => fresh.get(chat.id) ?? chat), ...next.filter((chat) => !seen.has(chat.id))];
}
