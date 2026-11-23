// Opening threads, leases, following another app's writes, and held messages. @store-slice: tests' store stub replaces it whole (tests/support/stubs.ts).

import { codexApi } from '../harness/adapters/codexApi';
import { native, type CodexItem } from '../lib/native';
import { errorText, ignoring, noteIgnored } from '../lib/ignored';
import type { Attachment, TurnState, Elsewhere } from './types';
import { HARNESS_TRAITS, nativeFamily, type HarnessFamily } from '../harness/family';
import { claudeTurnKey } from '../harness/claudeTranslate';
import { turnsAboveAfterPage } from './turnPages';
import { turnFromServer } from '../../shared/codexTurns.mjs';
import { createCodexOpener, markRunningElsewhere, unfinished } from './codexOpen';
import { sessionOf } from './session/useSession';
import { turnBusy } from './session/sessionState';
import { TranscriptReads } from '../../shared/transcriptReads.mjs';
import { coalesceLimitNotes } from '../../shared/limitNotices.mjs';
import { get, toast, upsertThread, set, patchRuntime } from './core';
import { olderCodexTurns, readingDisk } from './codexDisk';
import { chatOf, chatFamily, nativeOf } from './chats';
import { type SendOptions, giveBackToComposer, sendMessage } from './send';
import { loadGoal, subThreads } from './actions';
import { visiblePoll } from '../lib/visiblePoll';
import { onScreenNow } from './notifications';
import { runtime } from './runtime';
import { readFailed, readStale } from './chatReads';
import { deletionVisibility } from './deletionVisibility';

/* ------------------------------------------------------------------ */
/* thread lifecycle                                                    */
/* ------------------------------------------------------------------ */
/*
 * Codex writer leases (design §07) are the Codex adapter's in main (electron/harness/codex.cjs): it
 * resumes a thread right before a turn (or another write) and lets go once the thread has been idle
 * a few seconds. Reading needs no lock: open chats are read from disk and follow their rollout file,
 * which is also how Sage sees another app running them.
 */
/** Threads main holds the lease of, as this window last heard (`lease` item events). */
export const held = new Set<string>();
const diskReads = new TranscriptReads();
const openCodexThread = createCodexOpener({ held, diskReads, followOnDisk, setElsewhere, reopen: showThread });

/** Resume a Codex thread so Sage can write it. Throws ThreadLocked when another client holds it. */
export async function ensureResumed(threadId: string) {
  if (held.has(threadId)) return;
  const r = await native.codex.resume(threadId);
  if (r.locked) throw new ThreadLocked();
  diskReads.forget(threadId);
  held.add(threadId);
}
export class ThreadLocked extends Error {
  constructor() {
    super('This chat is open in another Codex app.');
  }
}

/**
 * A write on the chat's current Codex thread (compact, revert, shell command, goal…), under its
 * lease; main fills in the thread (nativeOf). When another client holds the thread, say so instead.
 */
export async function withLease<T = unknown>(chatId: string, method: string, params: Record<string, unknown> = {}): Promise<T | undefined> {
  const r = await native.codex.leased<T>(chatId, method, params);
  if (r.locked) {
    setElsewhere(chatId, { app: 'codex', running: !!get().elsewhere[chatId]?.running, hard: true });
    toast('This chat is open in another Codex app. Close it there to change it here.', 'error');
    return undefined;
  }
  return r.result;
}

/** Keep a lease regardless of activity (a voice session). */
export function pinLease(threadId: string, on: boolean) {
  // without the pin the lease is let go when idle, as for any chat
  native.codex.pinLease(threadId, on).catch((error) => noteIgnored("pin a Codex chat's lease", error));
}

export function onLease(e: Extract<CodexItem, { kind: 'lease' }>) {
  // main's answer: a thread a switch is starting is the chat's before this window learns the new segment
  const chat = e.chatId ?? chatOf(e.threadId);
  if (e.held) {
    diskReads.forget(e.threadId);
    held.add(e.threadId);
    if (e.thread && chat === e.threadId) upsertThread(e.thread);
    if (holdsLease(get().elsewhere[chat])) setElsewhere(chat, null);
    return;
  }
  held.delete(e.threadId);
  // let go of while on screen: keep it live from disk
  if (e.reason === 'released' && onScreenNow().has(chat) && chat === e.threadId) followOnDisk(chat);
}

/** openThread for a navigation: a failure the chat view can't show itself is a toast, not a silent blank chat. */
export function showThread(id: string): void {
  openThread(id).catch((error) => toast(`Couldn't open the chat: ${errorText(error)}`, 'error'));
}

/** Opening a chat that never switched, per harness: Claude Code reads its latest turns once, the basic harnesses their transcript. */
const OPEN_IN: Record<HarnessFamily, (id: string) => Promise<void> | undefined> = {
  codex: (id) => openCodexThread(id),
  claude: (id) => (get().runtime[id]?.loaded ? undefined : runtime().openClaudeThread(id)),
  acp: (id) => (get().runtime[id]?.loaded ? undefined : runtime().openAcpThread(id)),
};

export async function openThread(id: string, attempt = 0): Promise<void> {
  if (deletionVisibility.has(id)) return;
  set((s) => (s.unread[id] ? { unread: { ...s.unread, [id]: false } } : {}));
  // the model can set goals itself, so read the chat's goal whenever it is opened (a harness that keeps one)
  if (HARNESS_TRAITS[chatFamily(id)].readsGoalOnOpen && !get().threads[id]?.ephemeral)
    // the goal stays as last known; thread/goal/updated reports any change
    loadGoal(id).catch(ignoring("read a Codex chat's goal on opening it"));
  const rt = get().runtime[id];
  // a read under way covers this one, except one from disk: Codex is back, so the chat is read from it
  if (rt?.loading && !readingDisk.has(id)) return;
  // A switched chat is read once; fallback history and failed reads are read again.
  const source = get().segments[id];
  if (source?.length) {
    if (rt?.loaded && !readStale(rt)) return;
    await runtime().openCompositeThread(id);
  } else await OPEN_IN[nativeFamily(id)](id);
  const shown = get().runtime[id];
  // A source switch retires the old reader, but still owes the chat its first history load.
  if (!deletionVisibility.has(id) && source !== get().segments[id] && shown && (!shown.loaded || readStale(shown)) && !shown.loading) {
    if (attempt < 3) return openThread(id, attempt + 1);
    patchRuntime(id, () => ({ ...readFailed(new Error('The chat kept switching while its history loaded. Try again.')), loaded: false }));
  }
}

/** A writer that has been silent this long has probably exited without finishing its turn. */
const SILENT_WRITER_MS = 60_000;

/**
 * Follow an open Codex chat on disk while Sage doesn't hold it: re-read its latest turns whenever
 * its rollout file changes (and every few seconds while another client is running it). Changes
 * Sage didn't make mean another client is writing; when its turn ends, the chat is free again as
 * far as Sage can tell (it only learns of a lock by trying, and trying would take it).
 */
const diskFollows = new Map<string, { poll: () => void; lastChange: number }>();
let rolloutListener: (() => void) | null = null;
function followOnDisk(id: string) {
  if (diskFollows.has(id)) return;
  if (!rolloutListener)
    rolloutListener = native.codex.onRollout((tid) => {
      const f = diskFollows.get(tid);
      if (!f || held.has(tid)) return; // Sage's own writes arrive as events
      f.lastChange = Date.now();
      refreshFromDisk(tid).catch(ignoring('re-read a Codex chat whose rollout file changed'));
    });
  const stop = () => {
    diskFollows.get(id)?.poll();
    diskFollows.delete(id);
    diskReads.forget(id);
    // the watcher may already be gone; main drops it with the chat either way
    native.codex.unwatchRollout(id).catch(ignoring("stop watching a Codex chat's rollout file"));
    if (holdsLease(get().elsewhere[id]) && !get().runtime[id]?.held) setElsewhere(id, null);
  };
  const known = get().threads[id]?.path as string | undefined;
  (known ? Promise.resolve(known) : codexApi.threadRead(id).then((r) => r.thread?.path as string | undefined))
    .then((path) => {
      if (path && diskFollows.has(id)) return native.codex.watchRollout(id, path);
    })
    // nothing to watch: the poll below still refreshes a chat another app is running
    .catch((error) => noteIgnored("watch a Codex chat's rollout file", error));
  diskFollows.set(id, {
    lastChange: 0,
    // parked while the window is hidden: the rollout watcher still reports changes, and a show re-reads (wake)
    poll: visiblePoll(`codex-follow:${id}`, 4000, () => {
      // a message held for it keeps the chat followed off screen: the other app finishing is what sends it
      if (!onScreenNow().has(id) && !get().runtime[id]?.held) return stop();
      if (get().elsewhere[id]?.running && !held.has(id)) refreshFromDisk(id).catch(ignoring('poll a Codex chat another app is running'));
    }),
  });
}

async function refreshFromDisk(id: string) {
  // callers only refresh a chat this window doesn't hold; it may take the lease while the read runs
  const f = diskFollows.get(id);
  const shown = get().runtime[id]?.turns;
  const current = diskReads.begin(
    id,
    () =>
      !!f &&
      diskFollows.get(id) === f &&
      nativeOf(id) === id &&
      !held.has(id) &&
      !turnBusy(sessionOf(id)) &&
      get().runtime[id]?.turns === shown,
  );
  try {
    const page = await codexApi.threadTurns(id, { limit: 30, itemsView: 'full' });
    if (!current()) return;
    const latest = page.data.map(turnFromServer).reverse();
    if (!latest.length) return;
    // the other client may have quit mid-turn: after a long silence, stop showing it running
    const running = latest.some(unfinished) && !!f && Date.now() - f.lastChange < SILENT_WRITER_MS;
    if (running) markRunningElsewhere(latest);
    patchRuntime(id, (r) => {
      const at = r.turns.findIndex((t) => t.id === latest[0].id);
      const ids = new Set(latest.map((t) => t.id));
      const keep = at >= 0 ? r.turns.slice(0, at) : r.turns.filter((t) => !ids.has(t.id));
      const refreshed = latest.map((t) => ({ ...t, diff: t.diff ?? r.turns.find((was) => was.id === t.id)?.diff }));
      return { turns: [...keep, ...refreshed] };
    });
    const was = get().elsewhere[id];
    if (running) setElsewhere(id, { app: 'codex', running: true, hard: true });
    else if (was?.running) otherAppDone(id);
  } catch (error) {
    if (!current()) return;
    // the turns stay as shown; the next change or poll reads them again
    noteIgnored('re-read a Codex chat another app is running', error);
  }
}

/* ------------------------------------------------------------------ */
/* another app has the chat (design §07)                               */
/* ------------------------------------------------------------------ */
export function setElsewhere(chatId: string, e: Elsewhere | null) {
  if (e && subThreads.has(chatId)) return;
  const cur = get().elsewhere[chatId];
  if (cur ? e && cur.app === e.app && cur.running === e.running && cur.hard === e.hard : !e) return;
  set((s) => {
    const { [chatId]: _drop, ...rest } = s.elsewhere;
    return { elsewhere: e ? { ...rest, [chatId]: e } : rest };
  });
  // the other app wrote again: an earlier "continue here" no longer covers what it now remembers
  if (e?.running) patchRuntime(chatId, () => ({ continueHere: false }));
  if (!e) patchRuntime(chatId, () => ({ continueHere: false }));
}

export const ELSEWHERE_LABEL: Record<Elsewhere['app'], string> = {
  'claude-desktop': 'Claude desktop',
  'claude-cli': 'Claude Code in a terminal',
  sage: 'another MoPilot window',
  codex: 'another Codex app',
  other: 'another app',
};
/** The other app holds the chat's app-server lease (another Codex app), so only trying to send learns it let go. */
const HOLDS_LEASE: Record<Elsewhere['app'], boolean> = {
  'claude-desktop': false,
  'claude-cli': false,
  sage: false,
  codex: true,
  other: false,
};
const holdsLease = (e: Elsewhere | undefined) => !!e && HOLDS_LEASE[e.app];

/**
 * The other app finished its turn. A held message goes out now; otherwise say the chat is free.
 * For Codex the lock may still be held: sending finds out, and keeps the message held if so.
 */
export function otherAppDone(chatId: string) {
  const e = get().elsewhere[chatId];
  if (!e) return;
  const app = ELSEWHERE_LABEL[e.app];
  // a lease holder: no running writer seen any more; whether it still holds the lock is only learned by trying
  setElsewhere(chatId, holdsLease(e) ? null : { ...e, running: false });
  if (get().runtime[chatId]?.held) {
    // sendHeld keeps the message held when it doesn't go; only its own bookkeeping can fail here
    sendHeld(chatId, true).catch(ignoring('send the message held while another app had the chat'));
    return;
  }
  if (onScreenNow().has(chatId)) toast(`${app[0].toUpperCase()}${app.slice(1)} finished. You can continue here.`);
}

/**
 * Held messages are merged into one, which keeps the first one's options: one that sets a goal or plan mode can't
 * be merged with another (the goal would take the other's text, or go out as plain text). The held one stays.
 */
const mergeable = (a: Record<string, unknown> | null | undefined, b: Record<string, unknown> | null | undefined) =>
  !a?.goal && !a?.plan && !b?.goal && !b?.plan;

/** Keep a message until the other app lets go (or the user says to send it here). */
export function hold(chatId: string, text: string, attachments: Attachment[], opts: SendOptions) {
  const was = get().runtime[chatId]?.held;
  if (was && !mergeable(was.opts, opts as Record<string, unknown>)) {
    // nothing is lost: it goes back where it was typed, to send once the held one has gone
    giveBackToComposer(chatId, text, attachments);
    toast('A message is already waiting to send here. Send this one after it goes', 'info');
    return;
  }
  patchRuntime(chatId, (r) => ({
    held: r.held
      ? { text: `${r.held.text}\n\n${text}`, attachments: [...r.held.attachments, ...attachments], opts: r.held.opts }
      : { text, attachments, opts: opts as Record<string, unknown> },
  }));
  if (get().elsewhere[chatId]?.hard) retryHeld(chatId);
}

export function cancelHeld(chatId: string) {
  const h = get().runtime[chatId]?.held;
  patchRuntime(chatId, () => ({ held: null }));
  // the text and files back in the composer, after anything typed since, never over it
  if (h) giveBackToComposer(chatId, h.text, h.attachments);
}

/**
 * Send the held message. `here`: the user chose to continue here (or queued it while the other app
 * ran), so an idle Claude app that still has the chat open no longer stops it.
 */
export async function sendHeld(chatId: string, here = false) {
  const h = get().runtime[chatId]?.held;
  if (here) patchRuntime(chatId, () => ({ continueHere: true }));
  if (!h) return;
  patchRuntime(chatId, () => ({ held: null }));
  let sent: boolean | void;
  try {
    sent = await sendMessage(chatId, h.text, h.attachments, h.opts as SendOptions);
  } catch (error) {
    toast(`Couldn't send: ${errorText(error)}`, 'error');
    sent = false;
  }
  // main didn't take it: the message is held again (ahead of anything held since), not lost; one held since that
  // can't be merged with it goes back to the composer
  if (sent === false) {
    const since = get().runtime[chatId]?.held;
    const merge = !!since && mergeable(h.opts, since.opts);
    patchRuntime(chatId, () => ({
      held:
        since && merge ? { text: `${h.text}\n\n${since.text}`, attachments: [...h.attachments, ...since.attachments], opts: h.opts } : h,
    }));
    if (since && !merge) giveBackToComposer(chatId, since.text, since.attachments);
  }
}

/** "Send here" on the notice for a chat another Claude app has open. */
export function continueHere(chatId: string) {
  const e = get().elsewhere[chatId];
  if (e)
    toast(`When you go back to ${ELSEWHERE_LABEL[e.app]}, reopen this chat there before sending, or it will branch.`, 'info', {
      duration: 8000,
    });
  return sendHeld(chatId, true);
}

/** A held message for a chat another Codex client holds: keep trying until the lock is free. */
const heldRetries = new Map<string, ReturnType<typeof setTimeout>>();
function retryHeld(chatId: string) {
  if (heldRetries.has(chatId)) return;
  heldRetries.set(
    chatId,
    setTimeout(async () => {
      heldRetries.delete(chatId);
      const s = get();
      if (!s.runtime[chatId]?.held || s.elsewhere[chatId]?.running) return;
      try {
        await ensureResumed(nativeOf(chatId));
        // resumed, so this app is the writer now; main only says so when it newly takes the lease
        setElsewhere(chatId, null);
        toast('The other Codex app let go of this chat. Sending your message.');
        await sendHeld(chatId);
      } catch {
        retryHeld(chatId);
      }
    }, 5000),
  );
}

/**
 * Hold a message instead of sending it while another app has the chat: it is running a turn, holds
 * Codex's writer lock. An idle Claude process does not prevent continuing here.
 */
export function shouldHold(chatId: string): boolean {
  const e = get().elsewhere[chatId];
  if (!e) return false;
  return e.running || e.hard;
}

/**
 * How each harness reads the page of a chat's turns before a cursor, and when two of its turn ids are one turn; null
 * for a harness whose history comes whole.
 */
const OLDER_IN: Record<
  HarnessFamily,
  { read: (id: string, cursor: string) => Promise<{ turns: TurnState[]; nextCursor: string | null }>; key?: (id: string) => string } | null
> = {
  codex: { read: olderCodexTurns },
  claude: { read: (id, cursor) => runtime().loadOlderClaudeTurns(id, cursor), key: claudeTurnKey },
  acp: { read: (id, cursor) => runtime().loadOlderAcpTurns(id, cursor) },
};

/** chat id -> the older page being read, so a second request (the chat opened again meanwhile) shares it */
const olderLoads = new Map<string, Promise<void>>();

export function loadOlderTurns(id: string): Promise<void> {
  const rt = get().runtime[id];
  const older = OLDER_IN[nativeFamily(id)];
  // only a chat paged before its first switch has a cursor (a switched chat's read takes every turn), and that cursor's older
  // turns are all in the session the chat's id names
  if (!rt?.olderCursor || !older) return Promise.resolve();
  const reading = olderLoads.get(id);
  if (reading !== undefined) return reading;
  const cursor = rt.olderCursor;
  const key = older.key ?? ((t: string) => t);
  const load = older
    .read(id, cursor)
    .then((page) => {
      // a read from disk meanwhile started paging again: this page is not the one before what is shown
      if (get().runtime[id]?.olderCursor !== cursor) return;
      patchRuntime(id, (r) => {
        const shown = new Set(r.turns.map((t) => key(t.id)));
        const turns = coalesceLimitNotes([...page.turns.filter((t) => !shown.has(key(t.id))), ...r.turns]);
        return { turns, olderCursor: page.nextCursor, ...turnsAboveAfterPage(r, turns.length, page.nextCursor) };
      });
    })
    .finally(() => olderLoads.delete(id));
  olderLoads.set(id, load);
  return load;
}
