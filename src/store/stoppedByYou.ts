// A turn its person stopped, on any harness: Stop or Esc in the composer, or Esc and the control pill's Stop on the
// desktop (main's computer:changed with stoppedByYou). The turn's header then reads "You stopped after Ns".
// The mark is kept for the window's life by the turn's own id, so a turn read back from history (a live "ct-<uuid>" is
// read again as "h-<uuid>") keeps it; a restart forgets it, and the header reads "Stopped after Ns".

import type { TurnState } from './types';
import { get, patchTurn } from './core';

/** A turn id without its source prefix ("ct-", "h-", …): the same turn live and read back. */
const turnKey = (id: string) => id.replace(/^[a-z]+-(?=[0-9a-f]{8}-)/i, '');
const marked = new Set<string>();

/** Marks the chat's running turn as stopped by its person; a turn its harness has not named yet (or not shown) is left alone. */
export function markStoppedByYou(threadId: string) {
  const rt = get().runtime[threadId];
  const id = rt?.activeTurnId;
  if (!id || id.startsWith('pending-') || !rt.turns?.some((t) => t.id === id)) return;
  marked.add(`${threadId}\n${turnKey(id)}`);
  patchTurn(threadId, id, () => ({ stoppedByYou: true }));
}

/** Whether the chat's turn was stopped by its person, also once it was read back from history. */
export const stoppedByYou = (threadId: string, turn: Pick<TurnState, 'id' | 'stoppedByYou'>) =>
  !!turn.stoppedByYou || marked.has(`${threadId}\n${turnKey(turn.id)}`);

/** main's computer:changed: a person's Esc on the desktop stopped this chat (and the others it stopped with it). */
export function onComputerChanged(e: { chatId: string | null; stoppedByYou?: boolean }) {
  if (e.stoppedByYou && e.chatId) markStoppedByYou(e.chatId);
}
