// A Codex chat's initial history publication, including local takeover and recovery when live items retire a read.
import { codexApi } from '../harness/adapters/codexApi';
import { nativeOf } from './chats';
import { get, patchRuntime, upsertThread } from './core';
import type { Elsewhere, TurnState } from './types';
import { olderPagesKept } from './turnPages';
import { turnFromServer } from '../../shared/codexTurns.mjs';
import { loadSession, sessionOf } from './session/useSession';
import { turnBusy } from './session/sessionState';
import { TranscriptReads } from '../../shared/transcriptReads.mjs';
import { readFailed, readStale, readSucceeded } from './chatReads';
import { reuseTurn } from './turnReuse';
import { noteTurnsRead, readCodexChat } from './codexTurnsRead';
import { showFromDisk } from './codexDisk';
import { flushStreamNotifications } from './notifications';
import { liveTurnId } from '../lib/liveTurn';
import { beginHistoryOpen, readStableTranscript } from './transcriptRead';

type CodexOpenOwner = {
  held: Set<string>;
  diskReads: TranscriptReads;
  followOnDisk: (id: string) => void;
  setElsewhere: (id: string, value: Elsewhere | null) => void;
  reopen: (id: string) => void;
};

/** Initial reads own loading independently of the external transcript's publication slot. */
export function createCodexOpener({ held, diskReads, followOnDisk, setElsewhere, reopen }: CodexOpenOwner) {
  return async function openCodexThread(id: string) {
    const rt = get().runtime[id];
    // A held chat can skip reloading only after its full history was read successfully.
    if (rt?.loaded && !readStale(rt) && (held.has(id) || get().threads[id]?.ephemeral)) return;
    // Otherwise (re)read from disk: another app may have written it since it was last on screen.
    const hydrating = !rt?.loaded || readStale(rt);
    const opening = beginHistoryOpen(id, hydrating);
    const segments = get().segments[id];
    const owns = () => opening.owns() && get().segments[id] === segments && nativeOf(id) === id;
    try {
      await readStableTranscript(id, owns, flushStreamNotifications, async (unchanged) => {
        const current = diskReads.begin(id, unchanged);
        // Local takeover retires external-writer claims, not the initial history this read still owns.
        const fills = () => !get().runtime[id]?.loaded && unchanged();
        try {
          const got = await readCodexChat(codexApi, id, !!rt?.loaded && !rt.fromDisk && !readStale(rt));
          if (!got) return true;
          const { read, page } = got;
          if (!current() && !fills()) return !hydrating;
          const thread = read?.thread;
          if (thread) upsertThread(thread);
          if (thread?.model || thread?.reasoningEffort)
            patchRuntime(id, () => ({ settings: { model: thread.model, effort: thread.reasoningEffort } }));
          const turns = page.data.map(turnFromServer).reverse();
          // this window holds it, or another window of this app is running a turn on it (main knows);
          // a chat whose turn crashed here is ours too: its unfinished turn on disk is that turn, not another app's
          await loadSession(id);
          // A queued delta can retire this snapshot too; commit it before checking the transcript reference.
          flushStreamNotifications();
          const owned = current();
          if (!owned && !fills()) return !hydrating;
          const ss = sessionOf(id);
          const crashed = ss.turn === 'crashed';
          // a retired read began before this app took the chat: what it saw running is no other app's, and no turn of ours
          const mine = !owned || held.has(id) || turnBusy(ss) || crashed;
          // a turn another client is running isn't ours to stop or steer, so it is never the active turn here
          if (!mine) markRunningElsewhere(turns);
          // the latest running turn: an older one read back unfinished is not the one running (#2332)
          const activeId = owned && mine && !crashed ? liveTurnId(turns, null) : null;
          patchRuntime(id, (r) => {
            // merge with what is shown: older pages loaded before stay before the read, live turns that arrived while loading
            // after it; turns read from the rollout file while Codex was down are replaced whole, Codex's own read owns them
            const prior = r.fromDisk ? [] : r.turns;
            const ids = new Set(turns.map((t) => t.id));
            const { before, olderCursor } = olderPagesKept(prior, r.olderCursor, turns, page.nextCursor);
            const live = prior.slice(before.length).filter((t) => !ids.has(t.id));
            // the disk doesn't know why a crashed turn ended; keep what this window showed
            const kept = turns.map((t) => {
              const was = prior.find((x) => x.id === t.id);
              const next = { ...t, diff: t.diff ?? was?.diff };
              return reuseTurn(was, was?.error && !t.error ? { ...next, status: was.status, error: was.error } : next);
            });
            return {
              ...readSucceeded(r),
              loaded: true,
              loading: false,
              turns: [...before, ...kept, ...live],
              // with older pages still shown, paging goes on from the last of them
              olderCursor,
              activeTurnId: activeId ?? (crashed ? null : r.activeTurnId),
            };
          });
          noteTurnsRead(id, thread?.updatedAt);
          if (!mine && !get().threads[id]?.ephemeral) {
            followOnDisk(id);
            // an unfinished turn on disk that Sage isn't running is another client's
            if (turns.some(unfinished)) setElsewhere(id, { app: 'codex', running: true, hard: true });
          }
          return true;
        } catch (e) {
          flushStreamNotifications();
          if (!current() && !fills()) return !hydrating;
          // Codex is down: its history from its rollout file instead, read-only, while this read still owns the chat
          const fallback = await showFromDisk(
            id,
            () => {
              flushStreamNotifications();
              return current() || fills();
            },
            () => reopen(id),
          );
          if (fallback === 'retired') return !hydrating;
          if (fallback) return true;
          if (!current() && !fills()) return !hydrating;
          patchRuntime(id, () => readFailed(e));
          return true;
        }
      });
    } finally {
      opening.finish();
    }
  };
}

/** The app-server reads a turn another client is still running back as `interrupted` with no end time. */
export const unfinished = (t: TurnState) =>
  t.status === 'inProgress' || (t.status === 'interrupted' && t.completedAt == null && t.durationMs == null);
/** While another client holds the thread, show its open turn running (a really stopped turn has an end time). */
export function markRunningElsewhere(turns: TurnState[]) {
  for (const t of turns) if (unfinished(t)) t.status = 'inProgress';
}
