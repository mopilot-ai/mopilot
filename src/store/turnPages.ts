// Paging a chat's history: the page size, and the older pages a re-read of the latest turns keeps ahead of them.
import type { TurnState } from './types';

/** How many turns a chat's history is read in at a time, newest first (Codex's thread/turns, Claude's built turns). */
export const TURN_PAGE = 30;

/**
 * The older pages shown ahead of a re-read latest page, and where paging goes on from: the oldest of them while
 * they stay, else the page's own cursor. They stay when the page starts at a turn already shown after them; `key`
 * says when two turn ids are one turn (a Claude prompt shown live and read back).
 */
export function olderPagesKept(
  shown: TurnState[],
  shownCursor: string | null,
  page: TurnState[],
  pageCursor: string | null,
  key: (id: string) => string = (id) => id,
): { before: TurnState[]; olderCursor: string | null } {
  const ids = new Set(page.map((t) => key(t.id)));
  const at = shown.findIndex((t) => ids.has(key(t.id)));
  const before = at > 0 ? shown.slice(0, at) : [];
  return { before, olderCursor: before.length ? shownCursor : pageCursor };
}

type ChatWindow = { turns: TurnState[]; olderCursor?: string | null; turnsAbove?: number };

/** A turn's index in the chat from its index among the turns shown: what a segment's `start` counts. */
export const chatTurnIndex = (window: Pick<ChatWindow, 'turnsAbove'> | null | undefined, shown: number) =>
  shown + (window?.turnsAbove ?? 0);

/**
 * What a chat paged at its first switch records, given the turn its new segment starts at: how many turns the window lacks.
 * A window holding every turn, or one that already knows, has nothing to add; a message still on its way is no turn of main's.
 */
export function turnsAboveAfterSwitch(window: ChatWindow, start: number): { turnsAbove?: number } {
  if (!window.olderCursor || window.turnsAbove !== undefined) return {};
  const shown = window.turns.filter((t) => !t.id.startsWith('pending-')).length;
  return { turnsAbove: Math.max(0, start - shown) };
}

/** What an older page leaves above the window, now `shown` turns long and with `cursor` to go on from; nothing above once paging ends. */
export function turnsAboveAfterPage(window: ChatWindow, shown: number, cursor: string | null): { turnsAbove?: number } {
  if (window.turnsAbove === undefined) return {};
  return { turnsAbove: cursor === null ? 0 : Math.max(0, window.turnsAbove - (shown - window.turns.length)) };
}

/**
 * The window of a chat that switched harness and came back to the session its id names, after a page of that session's
 * latest turns: the page holds the session's earlier segment too, so it replaces only the current segment's turns, from
 * `cut` (where that segment starts in the window) on. The divider a switch put in front of a turn stays with it. Null when
 * the page does not reach a shown turn of the segment: where its turns go is not known.
 */
export function currentSegmentPage(
  shown: TurnState[],
  cut: number,
  page: TurnState[],
  key: (id: string) => string = (id) => id,
): TurnState[] | null {
  const current = shown.slice(cut);
  if (!current.length) return shown;
  const ids = new Set(current.map((t) => key(t.id)));
  const first = page.findIndex((t) => ids.has(key(t.id)));
  if (first < 0) return null;
  const at = current.findIndex((t) => key(t.id) === key(page[first].id));
  const before = new Map(current.map((t) => [key(t.id), t]));
  const read = page.slice(first).map((t) => withDivider(before.get(key(t.id)), t));
  return [...shown.slice(0, cut), ...current.slice(0, at), ...read];
}

/** A read-back turn with the switch dividers its shown copy carried in front of it. */
function withDivider(shown: TurnState | undefined, read: TurnState): TurnState {
  // a divider is a status note the window put among a turn's items (statusNote items are not ThreadItem's own types)
  const has = new Set(read.items.map((i) => (i as { id?: string }).id));
  const dividers = (shown?.items ?? []).filter((i) => {
    const note = i as { type: string; kind?: string; id?: string };
    return note.type === 'statusNote' && note.kind === 'switch' && !has.has(note.id);
  });
  return dividers.length ? { ...read, items: [...dividers, ...read.items] } : read;
}
