// The inbox owner's shared PR view, tray and anchor, keyed by chat; its rail outlives live/completed turn renderers.
import { useSyncExternalStore } from 'react';
import type { InboxCount, InboxView } from '../../lib/prInbox';

export interface PrLine {
  count: InboxCount | null;
  view: InboxView | null;
  /** the chats whose PRs wait on the user's answer, which "needs you" counts with the sessions the chat started itself */
  asking: readonly string[];
  tray: boolean;
  anchor: HTMLElement | null;
}

const NOTHING: PrLine = { count: null, view: null, asking: [], tray: false, anchor: null };
const lines = new Map<string, PrLine>();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function setPrLine(chatId: string, change: Partial<PrLine>) {
  lines.set(chatId, { ...(lines.get(chatId) ?? NOTHING), ...change });
  listeners.forEach((listener) => listener());
}

/** A count's button went: the tray loses its anchor only if that button was it, and a chat already gone stays gone. */
export function releasePrAnchor(chatId: string, el: HTMLElement) {
  if (lines.get(chatId)?.anchor === el) setPrLine(chatId, { anchor: null });
}

/** The chat left the screen: its count and tray go with it. */
export function clearPrLine(chatId: string) {
  lines.delete(chatId);
  listeners.forEach((listener) => listener());
}

export const usePrLine = (chatId: string): PrLine => useSyncExternalStore(subscribe, () => lines.get(chatId) ?? NOTHING);
