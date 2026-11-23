// Which chats run on a machine, read in one go from main (host:remoteChats) and shared by every reader on screen: a chat on a machine has a folder that is a path there, so nothing may look it up on this Mac. A read that has not answered keeps the folder unread; a read that failed says nothing about any chat (it is tried again), never "on a machine".
import { useEffect, useSyncExternalStore } from 'react';
import { native } from './native';
import { ignoring } from './ignored';
import { hostAllowedNow, useHostAccess, useHostAnswered } from './host';

type Chats = { owners: ReadonlyMap<string, string>; status: 'unknown' | 'ready' | 'failed' };
const UNKNOWN: Chats = { owners: new Map(), status: 'unknown' };
/** How long after a failed read the next one starts (a test shortens it). */
export const retryDelay = { ms: 2_000 };

let chats = UNKNOWN;
let inflight: Promise<void> | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
/** What the last start of a read was for: every row of a list asks, one read answers them all. */
let requested = '';
const listeners = new Set<() => void>();
/** Whether a read was asked for while one was under way: it starts as that one ends, so what happened meanwhile (a chat started, a continue) is in its answer. */
let again = false;
const same = (a: Chats, b: Chats) =>
  a.status === b.status && a.owners.size === b.owners.size && [...a.owners].every(([id, host]) => b.owners.get(id) === host);
const publish = (next: Chats) => {
  // rows that show nothing new are not drawn again
  if (same(chats, next)) return;
  chats = next;
  for (const l of listeners) l();
};

/** Reads every remote chat's machine again (a continue moved one, another window started one); a read already under way is joined. */
export function reloadHostChats(): Promise<void> {
  if (inflight !== null) {
    again = true;
    return inflight;
  }
  inflight = Promise.resolve()
    .then(() => native.host.remoteChats())
    .then(
      // an answer that is no list names no chat
      (rows) => publish({ owners: new Map((Array.isArray(rows) ? rows : []).map((r) => [r.chatId, r.hostId])), status: 'ready' }),
      (e) => {
        ignoring('read the chats on machines')(e);
        publish({ owners: chats.owners, status: 'failed' });
        // one timer for every reader: the read is tried again until it answers
        clearTimeout(retry);
        retry = setTimeout(() => void reloadHostChats(), retryDelay.ms);
      },
    )
    .finally(() => {
      inflight = null;
      if (again) {
        again = false;
        void reloadHostChats();
      }
    });
  return inflight;
}

/** A chat just started on `hostId` from this window: known before the next read. */
export function noteHostChat(chatId: string, hostId: string) {
  publish({ owners: new Map(chats.owners).set(chatId, hostId), status: chats.status });
}

export const subscribeHostChats = (cb: () => void) => (listeners.add(cb), () => void listeners.delete(cb));
const NONE: Chats = { owners: new Map(), status: 'ready' };

/** The chats on machines, following main: read once Host exists (and again after `reloadHostChats`), retried after a failure. Without Host there are none. */
export function useHostChats(): Chats & { answered: boolean } {
  const allowed = useHostAccess();
  const answered = useHostAnswered();
  const current = useSyncExternalStore(subscribeHostChats, () => chats);
  useEffect(() => {
    if (!allowed || requested === 'first') return;
    requested = 'first';
    void reloadHostChats();
  }, [allowed]);
  if (!answered) return { ...UNKNOWN, answered };
  return { ...(allowed ? current : NONE), answered };
}

/** The machine id a chat runs on, '' for this Mac, null while that is not known yet. */
export function machineOfChat(state: Chats & { answered: boolean }, chatId: string | null): string | null {
  if (!chatId) return '';
  if (!state.answered || state.status === 'unknown') return null;
  return state.owners.get(chatId) ?? '';
}

/**
 * The folder a reader on this Mac may look in, for code outside a component (a command, a click): '' for a chat on a machine. Without Host nothing is on a machine; before the first read has answered it waits for it,
 * and a read that failed says nothing about the chat (this Mac's).
 */
export async function chatFolderHere(chatId: string | null, cwd: string): Promise<string> {
  if (!chatId || !hostAllowedNow()) return cwd;
  if (chats.status === 'unknown') await reloadHostChats();
  return chats.owners.has(chatId) ? '' : cwd;
}

/** Live destination identity for asynchronous UI admission; null is unresolved and an empty id means this Mac. */
export function hostOfChatNow(chatId: string | null): string | null {
  if (!chatId || !hostAllowedNow()) return '';
  return chats.status === 'unknown' ? null : (chats.owners.get(chatId) ?? '');
}

/** Whether a chat is on a machine, or may be (Host exists and its chats are not read yet), for code that must not touch this Mac's disk for such a chat; false without Host and for a chat that is this Mac's. */
export function onMachineNow(chatId: string | null): boolean {
  if (!chatId || !hostAllowedNow()) return false;
  return chats.status === 'unknown' || chats.owners.has(chatId);
}

/** Forgets what was read (tests). */
export function resetHostChats() {
  chats = UNKNOWN;
  inflight = null;
  requested = '';
  again = false;
  clearTimeout(retry);
}
