// Claude external-session following: transcript watches, refresh timers, visible chats and presence reconciliation.
import { native } from '../../../lib/native';
import { ignoring, noteIgnored } from '../../../lib/ignored';
import type { ElsewhereApp, TurnState } from '../../../store/types';
import { get as getState, patchRuntime, touchChat } from '../../../store/core';
import { nativeOf, chatOf } from '../../../store/chats';
import { setElsewhere, otherAppDone, sendHeld } from '../../../store/threads';
import { LIVE_WINDOW_MS, claudeTurnKey, promptUuidOf } from '../../../harness/claudeTranslate';
import { claudeSessionId, claudeThreadId } from '../../../harness/types';
import { ownerOf } from '../../../harness/ownership';
import { readClaudeTurns } from './history';
import { TURN_PAGE, chatTurnIndex, currentSegmentPage, olderPagesKept } from '../../../store/turnPages';
import { runtime } from '../../../store/runtime';
import { sessionOf } from '../../../store/session/useSession';
import { turnBusy } from '../../../store/session/sessionState';
import { TranscriptReads } from '../../../../shared/transcriptReads.mjs';
import { coalesceLimitNotes } from '../../../../shared/limitNotices.mjs';
import { visibleChats } from '../../../store/split';

/** Local stream ownership stays with the renderer harness; following consults it at each read boundary. */
export function createClaudeFollowing({
  fresh,
  readWhole = (id) => runtime().openCompositeThread(id),
}: {
  fresh: ReadonlySet<string>;
  /** read a switched chat whole, when a page of its session can't be placed among its turns */
  readWhole?: (id: string) => Promise<void>;
}) {
  const followed = new Set<string>();
  const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reads = new TranscriptReads();
  const localRunning = (id: string) => turnBusy(sessionOf(id));
  /** A local stream is authoritative even if its turn finishes before an outstanding disk read. */
  function localWrite(id: string) {
    reads.forget(id);
    clearTimeout(refreshTimers.get(id));
    refreshTimers.delete(id);
    if (getState().elsewhere[id]?.running) setElsewhere(id, null);
  }
  /** Watch the open chat's transcript; Sage's own sessions stream through the SDK instead. */
  function follow(id: string) {
    if (followed.has(id) || !getState().threads[id]) return;
    followed.add(id);
    // a watch that failed is not one in place: forget it, so the chat is watched again when it comes back on screen
    native.claude.watch(claudeSessionId(id)).then(
      (ok) => !ok && followed.delete(id),
      (error) => (noteIgnored('follow a Claude Code transcript another app may write', error), followed.delete(id)),
    );
  }
  function onScreen(): Set<string> {
    const s = getState();
    return new Set<string>([...visibleChats(s), ...s.paneTabs.map((t) => t.threadId ?? '')]);
  }
  /** Stop following chats that are no longer on screen; catch up on ones that came back. */
  function syncFollowed() {
    const open = onScreen();
    // a message held for it keeps the chat followed off screen: the other app finishing is what sends it
    for (const id of followed)
      if (!open.has(id) && !getState().runtime[id]?.held) {
        followed.delete(id);
        reads.forget(id);
        clearTimeout(refreshTimers.get(id));
        refreshTimers.delete(id);
        // the watcher may already be gone; main drops it with the session either way
        native.claude.unwatch(claudeSessionId(id)).catch(ignoring('stop following a Claude Code transcript'));
      }
    // a loaded chat coming back on screen may have moved on in another app while it was away
    for (const id of open)
      if (
        id &&
        ownerOf(id) === 'claude' &&
        !followed.has(id) &&
        getState().runtime[id]?.loaded &&
        !fresh.has(id) &&
        !getState().threads[id]?.ephemeral
      ) {
        follow(id);
        refreshFollowed(id).catch(ignoring('re-read a Claude Code chat that came back on screen'));
      }
  }
  /**
   * Whether a re-read transcript went on from what was shown: another turn, a turn that was running got another
   * item or ended, or a written turn is gone (rewound). A turn is the same under its live and read-back ids
   * (claudeTurnKey), and one that ran here shows live-only items, so re-showing a chat after its own turn (opening
   * it) is not activity; nor is a message that never reached the transcript (a pending- turn that failed).
   */
  function transcriptMoved(prev: TurnState[], next: TurnState[]): boolean {
    const shown = new Map(prev.map((t) => [claudeTurnKey(t.id), t]));
    const read = new Set(next.map((t) => claudeTurnKey(t.id)));
    return (
      prev.some((t) => promptUuidOf(t.id) && !read.has(claudeTurnKey(t.id))) ||
      next.some((t) => {
        const was = shown.get(claudeTurnKey(t.id));
        return !was || (was.status === 'inProgress' && (t.status !== was.status || t.items.length !== was.items.length));
      })
    );
  }
  /**
   * Re-read a followed transcript; once it goes quiet, a turn left open is closed by the next read.
   * Runs whenever Sage isn't mid-turn on it, even with its CLI still open: the main process only
   * reports writes that came from another app.
   */
  async function refreshFollowed(id: string) {
    const nid = nativeOf(id);
    if (nid !== id || !followed.has(id)) return;
    if (localRunning(id)) return localWrite(id);
    const shown = getState().runtime[id]?.turns;
    const current = reads.begin(
      id,
      () => followed.has(id) && nativeOf(id) === nid && !localRunning(id) && getState().runtime[id]?.turns === shown,
    );
    try {
      const cwd = getState().threads[id]?.cwd ?? '';
      const page = await readClaudeTurns(id, id, cwd, { liveTail: true, closedTail: true, limit: TURN_PAGE });
      if (!current()) return;
      const session = await native.session.snapshot(id);
      if (!current() || !session) return;
      if (turnBusy(session)) return localWrite(id);
      // a turn still being written stays open only while another app is running the chat
      const latest = !session.runningElsewhere && page.closedTail ? [...page.turns.slice(0, -1), page.closedTail] : page.turns;
      const r = getState().runtime[id];
      const segs = getState().segments[id];
      let turns: TurnState[];
      if (segs && segs.length > 1) {
        // back on the session its id names after a switch (#4257): the page holds that session's earlier segment too, and
        // none of the other harness's turns between, so it replaces only the current segment's; paging stays as it was
        const shownTurns = r?.turns ?? [];
        const cut = Math.min(shownTurns.length, Math.max(0, segs[segs.length - 1].start - chatTurnIndex(r, 0)));
        const placed = currentSegmentPage(shownTurns, cut, latest, claudeTurnKey);
        if (!placed) return void readWhole(id).catch(ignoring('read a switched Claude Code chat whole'));
        turns = coalesceLimitNotes(placed);
        patchRuntime(id, () => ({ turns, loaded: true }));
      } else {
        // the latest page replaces what it covers; older pages read before stay ahead of it
        const kept = olderPagesKept(r?.turns ?? [], r?.olderCursor ?? null, latest, page.olderCursor, claudeTurnKey);
        turns = coalesceLimitNotes([...kept.before, ...latest]);
        patchRuntime(id, () => ({ turns, olderCursor: kept.olderCursor, loaded: true }));
      }
      const moved = transcriptMoved(r?.turns ?? [], turns);
      // a turn still being written that Sage isn't running is another app's (design §07)
      const was = getState().elsewhere[id];
      if (turns.at(-1)?.status === 'inProgress') setElsewhere(id, { app: was?.app ?? 'other', running: true, hard: false });
      else if (was?.running) otherAppDone(id);
      // only another app's new writes are activity; re-reading an unchanged transcript (opening the chat) must not reorder the sidebar
      if (moved) touchChat(id);
      clearTimeout(refreshTimers.get(id));
      if (turns.at(-1)?.status === 'inProgress')
        refreshTimers.set(
          id,
          setTimeout(() => refreshFollowed(id), LIVE_WINDOW_MS + 1000),
        );
    } catch (error) {
      if (!current()) return;
      // a read that failed (a transcript mid-write or gone): the turns shown stay, and the next change reads it again
      noteIgnored('re-read a Claude Code transcript another app is writing', error);
    }
  }

  return { followed, follow, onScreen, syncFollowed, refreshFollowed, localWrite };
}

/**
 * Which Claude chats other apps have open (design §07): one process scan every few seconds while
 * Sage is in front, less often behind. Running state comes from following the transcript.
 */
export async function pollPresence() {
  let map: Record<string, ElsewhereApp[]>;
  try {
    map = await native.claude.presence();
  } catch (error) {
    // the chats keep what the last scan found; the next scan asks again
    noteIgnored('scan for other apps with Claude Code chats open', error);
    return;
  }
  const s = getState();
  const seen = new Set<string>();
  for (const [sid, apps] of Object.entries(map)) {
    const chat = chatOf(claudeThreadId(sid));
    if (!s.threads[chat] && !s.runtime[chat]) continue;
    seen.add(chat);
    const cur = s.elsewhere[chat];
    setElsewhere(chat, { app: apps[0], running: !!cur?.running, hard: false });
  }
  // gone from the process table and not writing: the chat is free again
  for (const [chat, e] of Object.entries(getState().elsewhere))
    if (e.app !== 'codex' && !seen.has(chat) && !e.running) {
      setElsewhere(chat, null);
      // a message held for it goes out now (no-op without one); sendHeld keeps it held when it doesn't go
      sendHeld(chat).catch(ignoring('send the message held for a Claude Code chat'));
    }
}
