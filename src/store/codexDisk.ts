// A Codex chat's history read from its rollout file while Codex's app-server is down, read-only, until Codex is back.
import { codexApi } from '../harness/adapters/codexApi';
import { native } from '../lib/native';
import { noteIgnored } from '../lib/ignored';
import { turnFromServer } from '../../shared/codexTurns.mjs';
import type { AppState } from './state';
import type { TurnState } from './types';
import { get, patchRuntime } from './core';
import { TURN_PAGE } from './turnPages';

/**
 * Codex's app-server isn't running for this window: it quit (connError says so as soon as it does, before main says it
 * is bringing it back), main is bringing it back, or it gave up (or never started).
 */
export const codexDown = (s: AppState = get()) => s.conn === 'error' || s.codexRestart != null || s.connError != null;

/** Chats whose history is being read from disk: an app-server read asked for meanwhile goes ahead of it (openThread). */
export const readingDisk = new Set<string>();

/**
 * Turns from disk are the chat's own `limit` latest before `cursor` (all without a limit), as the view holds them. A
 * turn the file leaves unfinished ended with Codex (nothing runs it while Codex is down), so it shows as interrupted.
 */
async function fromDisk(id: string, o: { cursor?: string; limit?: number } = {}) {
  const r = await native.codex.rolloutHistory(id, { hint: (get().threads[id]?.path as string | undefined) ?? null, ...o });
  const ended = (t: TurnState): TurnState => (t.status === 'inProgress' ? { ...t, status: 'interrupted' } : t);
  return r && { turns: r.turns.map((t) => ended(turnFromServer(t))), nextCursor: r.nextCursor };
}

/**
 * A read of a Codex chat failed while Codex is down: its latest turns from its rollout file instead, read-only (its
 * notice says it can't send until Codex runs). `owns`: the failed read still owns the chat, so it may publish;
 * `reopen` reads the chat again (openThread). True when shown or queued to reopen, false leaves the read's error;
 * `retired` leaves recovery to the current logical opener rather than silently completing its initial history.
 */
export async function showFromDisk(id: string, owns: () => boolean, reopen: () => void): Promise<boolean | 'retired'> {
  if (!codexDown()) return false;
  readingDisk.add(id);
  let page: Awaited<ReturnType<typeof fromDisk>> = null;
  try {
    page = await fromDisk(id, { limit: TURN_PAGE });
  } catch (error) {
    // no history on disk either: the read's own error (Codex isn't connected) says what to do
    noteIgnored("read a Codex chat's rollout file", error);
  } finally {
    readingDisk.delete(id);
  }
  // a newer read took the chat: what it shows wins
  if (!owns()) return 'retired';
  // nothing the file shows (no rollout, or one this can't read the messages of): the read's error stands, with Retry
  if (!page?.turns.length) return false;
  // Codex came back while the file was read: the chat is read from it, once this read has let go of the chat
  if (!codexDown()) {
    setTimeout(reopen, 0);
    return true;
  }
  patchRuntime(id, () => ({
    loaded: true,
    loading: false,
    turns: page.turns,
    olderCursor: page.nextCursor,
    activeTurnId: null,
    error: null,
    errorFromRead: false,
    fromDisk: true,
  }));
  return true;
}

/** Every turn of a Codex thread from its rollout file (a switched chat's Codex part while Codex is down), or null. */
export async function allFromDisk(threadId: string): Promise<TurnState[] | null> {
  if (!codexDown()) return null;
  const page = await fromDisk(threadId).catch((error) => (noteIgnored("read a Codex chat's rollout file", error), null));
  return page?.turns ?? null;
}

/** A Codex chat's older page: from its rollout file when that is where its turns were read, else from the app-server. */
export async function olderCodexTurns(id: string, cursor: string): Promise<{ turns: TurnState[]; nextCursor: string | null }> {
  if (cursor.startsWith('rollout:')) return (await fromDisk(id, { cursor, limit: TURN_PAGE })) ?? { turns: [], nextCursor: null };
  const page = await codexApi.threadTurns(id, { limit: TURN_PAGE, cursor, itemsView: 'full' });
  return { turns: page.data.map(turnFromServer).reverse(), nextCursor: page.nextCursor };
}

/** Codex is back: chats shown from disk read again from it (`open`: openThread), the ones on screen now. */
export function reloadFromCodex(onScreen: Set<string>, open: (id: string) => void) {
  for (const [id, r] of Object.entries(get().runtime)) if (r.fromDisk && onScreen.has(id)) open(id);
}
