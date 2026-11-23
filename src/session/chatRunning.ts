// Whether a chat has a turn running on any harness, and which chats run in a folder without a worktree of their own.
import type { AppState } from '../store/state';
import type { Thread, ThreadRuntime } from '../store/types';
import { EMPTY_SESSION, turnBusy, type SessionState } from '../store/session/sessionState';

/** A turn is running: main's session once this window has it, else the native list's status (the sidebar's spinner). */
export function chatRunning(
  thread: Pick<Thread, 'status'> | undefined,
  session: SessionState,
  runtime: Pick<ThreadRuntime, 'activeTurnId'> | { activeTurnId: boolean } | undefined,
): boolean {
  return session.rev ? session.turn === 'running' : !!runtime?.activeTurnId || thread?.status?.type === 'active';
}

const folderKey = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/** Each chat main's session is known for, and whether a turn is under way there (running or waiting on the user). */
export function sessionBusy(sessions: Record<string, SessionState>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [id, session] of Object.entries(sessions)) if (session.rev) out[id] = turnBusy(session);
  return out;
}

const byFolder = new WeakMap<AppState['threads'], Map<string, Thread[]>>();

/** The chats whose own folder is `want`, indexed once per `threads` object: a streamed frame does not rewalk every chat. */
function chatsIn(s: Pick<AppState, 'threads'>, want: string): Thread[] {
  let index = byFolder.get(s.threads);
  if (!index) {
    index = new Map();
    for (const t of Object.values(s.threads)) {
      if (!t.cwd) continue;
      const key = folderKey(t.cwd);
      index.set(key, [...(index.get(key) ?? []), t]);
    }
    byFolder.set(s.threads, index);
  }
  return index.get(want) ?? [];
}

/**
 * Whether a chat on any harness has a turn under way in `folder` itself (`busy`: sessionBusy's map, else the native
 * status): a new chat there would change the same files. A chat in a worktree runs in the worktree's folder, so it never
 * matches.
 */
export function runningInFolder(folder: string, s: Pick<AppState, 'threads' | 'runtime'>, busy: Record<string, boolean>): boolean {
  return chatsIn(s, folderKey(folder)).some((t) =>
    Object.hasOwn(busy, t.id) ? busy[t.id] : chatRunning(t, EMPTY_SESSION, s.runtime[t.id]),
  );
}
