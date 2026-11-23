// The sidebar's last known chats: saved with the window's state, drawn at the first frame, and checked against each list as it answers (a row its list no longer has goes after the list, never before).

import { useSyncExternalStore } from 'react';
import type { Thread } from './types';
import { get, set, useStore } from './core';
import { visibleChats } from './split';
import { native } from '../lib/native';
import { noteIgnored } from '../lib/ignored';
import { noteOwner, ownerOf } from '../harness/ownership';
import { isMomoChat } from '../lib/momoChats';

/** A snapshot written by a build that kept it in another shape is not read (the lists fill the sidebar as before). */
export const SNAPSHOT_VERSION = 1;
/** The newest chats kept; a longer history is drawn from the lists. */
export const MAX_SNAPSHOT_ROWS = 3000;
/** How long a change waits for the next one before the snapshot is written. */
export const WRITE_DELAY_MS = 2000;
const PREVIEW_CHARS = 160;

/** One row as saved: the chat as the sidebar lists it, without its turns, and the harness that owns it. */
export type SnapshotRow = Thread & { owner?: string };
export interface SidebarSnapshot {
  version: number;
  rows: SnapshotRow[];
}

/** The chats the sidebar lists as a snapshot: the newest first, each as the lists return it (nothing running, no turns). */
export function snapshotOf(threads: Record<string, Thread>, momoChats: Parameters<typeof isMomoChat>[0] = {}): SidebarSnapshot {
  // MoMo's chats are in no list of chats, so in no snapshot
  const rows = Object.values(threads)
    .filter((t) => !t.ephemeral && !isMomoChat(momoChats, t.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SNAPSHOT_ROWS)
    .map((t) => ({
      ...t,
      turns: [],
      preview: (t.preview ?? '').slice(0, PREVIEW_CHARS),
      status: { type: 'notLoaded' as const },
      owner: ownerOf(t.id),
    }));
  return { version: SNAPSHOT_VERSION, rows };
}

/** Rows as seeded and not yet checked against their own list: a row is removed only while it is still this object. */
const seeded = new Map<string, Thread>();

const isRow = (r: unknown): r is SnapshotRow => {
  const t = r as Partial<SnapshotRow> | null;
  return !!t && typeof t.id === 'string' && typeof t.cwd === 'string' && Number.isFinite(t.updatedAt) && Number.isFinite(t.createdAt);
};

/**
 * The threads a saved snapshot starts the window with, or null when there is none to read (missing, another version or
 * not a snapshot): the lists then fill the sidebar and its projects say they are loading. `skip` names chats that must
 * not come back (archived, deleted). Each row keeps its owner, so the list of that harness can check it.
 */
export function seedThreads(
  raw: unknown,
  skip: (id: string) => boolean,
): { threads: Record<string, Thread>; threadOrder: string[] } | null {
  const snap = raw as Partial<SidebarSnapshot> | null | undefined;
  if (!snap || snap.version !== SNAPSHOT_VERSION || !Array.isArray(snap.rows)) return null;
  const threads: Record<string, Thread> = {};
  const threadOrder: string[] = [];
  seeded.clear();
  for (const row of snap.rows) {
    if (!isRow(row) || skip(row.id) || threads[row.id]) continue;
    const { owner, ...rest } = row;
    noteOwner(row.id, owner);
    const t = { ...rest, turns: [], status: { type: 'notLoaded' } } as unknown as Thread;
    threads[t.id] = t;
    threadOrder.push(t.id);
    seeded.set(t.id, t);
  }
  lists.setState({ known: true });
  return { threads, threadOrder };
}

/**
 * A list answered: its chats are confirmed, and (when it listed everything it can) the seeded rows it owns and did not
 * list are removed, unless a window shows them or something changed them since (a rename, a new message): those are live.
 * A list that failed or stopped at a page confirms what it has and removes nothing.
 */
export function confirmList({ listed, owns, complete }: { listed: Iterable<string>; owns: (id: string) => boolean; complete: boolean }) {
  for (const id of listed) seeded.delete(id);
  if (!complete) return;
  const open = new Set(visibleChats(get()));
  const gone: string[] = [];
  for (const [id, row] of seeded) {
    if (!owns(id)) continue;
    seeded.delete(id);
    if (get().threads[id] === row && !open.has(id)) gone.push(id);
  }
  if (!gone.length) return;
  const drop = new Set(gone);
  set((s) => ({
    threads: Object.fromEntries(Object.entries(s.threads).filter(([id]) => !drop.has(id))),
    threadOrder: s.threadOrder.filter((id) => !drop.has(id)),
  }));
}

/* ------------------------------------------------------------------ */
/* what is still loading                                               */
/* ------------------------------------------------------------------ */
/** The lists the window waits for at launch, and whether a snapshot told what the projects hold. */
type Lists = { pending: string[]; known: boolean };
let listsNow: Lists = { pending: [], known: false };
const listeners = new Set<(s: Lists, prev: Lists) => void>();
/** A small store of its own: this module is reached from the harness loaders, which load without the window's UI libraries. */
export const lists = {
  getState: () => listsNow,
  setState(patch: Partial<Lists> | ((s: Lists) => Partial<Lists>)) {
    const prev = listsNow;
    listsNow = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) };
    for (const l of [...listeners]) l(listsNow, prev);
  },
  subscribe(l: (s: Lists, prev: Lists) => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};
/** Launch starts waiting for these lists. */
export const expectLists = (names: string[]) => lists.setState((s) => ({ pending: [...new Set([...s.pending, ...names])] }));
/** A list answered or failed: the window stops waiting for it (once all have, an empty project is empty). */
export const settleList = (name: string) =>
  lists.setState((s) => (s.pending.includes(name) ? { pending: s.pending.filter((n) => n !== name) } : s));
/** Whether a project with no chat yet is still being read: nothing is known of it, and the lists have not all answered. */
export const useLoadingEmpty = () =>
  useSyncExternalStore(
    (notify) => lists.subscribe(() => notify()),
    () => listsNow.pending.length > 0 && !listsNow.known,
  );

/* ------------------------------------------------------------------ */
/* writing                                                             */
/* ------------------------------------------------------------------ */
let lastWritten = '';
let timer: ReturnType<typeof setTimeout> | undefined;

/** Save the snapshot now when its lists have all answered (an unfinished launch keeps the older one) and it changed. */
export function flushSnapshot() {
  clearTimeout(timer);
  timer = undefined;
  if (lists.getState().pending.length) return;
  const snapshot = snapshotOf(get().threads, get().momoChats);
  const text = JSON.stringify(snapshot);
  if (text === lastWritten) return;
  lastWritten = text;
  native.state.write({ sidebarSnapshot: snapshot }).catch((error) => {
    // the next change writes it again
    lastWritten = '';
    noteIgnored("save the sidebar's chats", error);
  });
}
const later = () => {
  clearTimeout(timer);
  timer = setTimeout(flushSnapshot, WRITE_DELAY_MS);
};

/** Write the snapshot after changes to the chats and once the launch lists have answered, and when the window closes. */
export function startSnapshotWriter() {
  useStore.subscribe((s, prev) => {
    if (s.threads !== prev.threads) later();
  });
  lists.subscribe((s, prev) => {
    if (prev.pending.length && !s.pending.length) later();
  });
  window.addEventListener('pagehide', flushSnapshot);
}
