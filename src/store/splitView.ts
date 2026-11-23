// The store's split view actions: every layout change applied atomically to the window's current state, a chat id @store-slice: tests' store stub replaces it whole (tests/support/stubs.ts).
// replaced wherever this window shows it, and what the split view UI asks (open with room for it, close, move, cycle focus).

import { get, set, toast } from './core';
import { chatOf } from './chats';
import { chatPaneForView } from './chatPanes';
import { navigate } from './panes';
import { MAX_SPLIT_PANES, applySplit, primaryChat, pruneSplitOwners, type SplitOp, type SplitResult } from './split';
import { dispatchComposerFocus } from '../lib/composerEvents';
import { showThread } from './threads';

/**
 * Applies one layout op to the window's layout as it is when the store takes it (never a snapshot from before an
 * await), with the side pane following the focused chat. A chat that comes on screen is opened.
 */
export function applySplitOp(op: SplitOp): SplitResult {
  const done: { result: SplitResult } = { result: 'invalid' };
  set((s) => {
    const { layout, result } = applySplit(s.split, primaryChat(s), op);
    done.result = result;
    // Settings hides the layout temporarily; navigation reconciles its owners before showing it again.
    const split = s.route.name === 'settings' ? layout : pruneSplitOwners(layout, primaryChat(s));
    return split === s.split ? {} : { ...chatPaneForView(s, { route: s.route, split }, chatOf), split };
  });
  if (done.result === 'opened' && op.op === 'open') showThread(op.chatId);
  if (done.result === 'replaced' && op.op === 'replace') showThread(op.next);
  return done.result;
}

/**
 * A chat replaced by another (a harness switch that starts a new chat): a split pane showing it shows the new one in
 * place, keeping its focus; anywhere else the new chat opens in the primary pane, as before split view.
 */
export function replaceChatInView(chatId: string, next: string) {
  if (applySplitOp({ op: 'replace', chatId, next }) === 'replaced') return;
  navigate({ name: 'thread', id: next });
}

/** A chat that is gone (archived, deleted, retired): no split pane shows it, and the primary pane goes home from it. */
export function retireChatFromView(chatId: string) {
  applySplitOp({ op: 'retire', chatId });
  if (primaryChat(get()) === chatId) navigate({ name: 'home' });
}

/** The split panes the main area has room for now (SplitFrame measures it); until it is measured, the layout's cap. */
let room = MAX_SPLIT_PANES;
export const setSplitRoom = (n: number) => {
  room = n;
};
export const splitRoomNow = () => room;

/** What the user is told when a chat can't get a pane, by why. */
export const NO_ROOM = 'The window is too narrow for another split view';
export const SPLIT_FULL = `Split view shows up to ${MAX_SPLIT_PANES + 1} chats`;

/**
 * The user opens a chat in split view (a menu, a modifier click, a drop at split-pane index `at`): a new pane beside the
 * others when the window has room for it, else it says why. A chat already on screen takes the focus instead.
 */
export function openInSplit(chatId: string, at?: number): SplitResult {
  const s = get();
  const shown = primaryChat(s) === chatId || s.split.panes.some((p) => p.chatId === chatId);
  if (!shown && s.split.panes.length >= room) {
    toast(s.split.panes.length >= MAX_SPLIT_PANES ? SPLIT_FULL : NO_ROOM);
    return 'full';
  }
  const result = applySplitOp(at === undefined ? { op: 'open', chatId } : { op: 'open', chatId, at });
  if (result === 'full') toast(SPLIT_FULL);
  return result;
}

/** The pane one place left (-1) or right (+1) of where it is; the ends stay. */
export function moveSplitPane(chatId: string, by: -1 | 1): SplitResult {
  const at = get().split.panes.findIndex((p) => p.chatId === chatId);
  return at < 0 ? 'missing' : applySplitOp({ op: 'move', chatId, to: at + by });
}

/** The panes in focus order: the primary one, then each split pane left to right. */
const focusOrder = () => ['primary', ...get().split.panes.map((p) => p.chatId)];

/**
 * The focus to the next (+1) or previous (-1) pane, wrapping (⌃] and ⌃[), and the keyboard to its composer. With no
 * split panes there is nothing to cycle.
 */
export function cycleSplitFocus(by: -1 | 1): boolean {
  const order = focusOrder();
  if (order.length < 2) return false;
  const next = order[(order.indexOf(get().split.focus) + by + order.length) % order.length];
  applySplitOp({ op: 'focus', target: next });
  const chat = next === 'primary' ? primaryChat(get()) : next;
  if (chat) dispatchComposerFocus(window, chat);
  else window.dispatchEvent(new Event('focus-composer'));
  return true;
}

/** Closes the focused split pane (⌃⌘W); the primary pane is never closed this way. */
export function closeFocusedSplit(): boolean {
  const focus = get().split.focus;
  return focus !== 'primary' && applySplitOp({ op: 'close', chatId: focus }) === 'closed';
}
