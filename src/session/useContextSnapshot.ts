// A chat's context snapshot as main keeps it (electron/context): shared by every display, for the chat's current owner only, asked for once and then kept current by main's pushes.
import { useSyncExternalStore } from 'react';
import { useStore } from '../store/core';
import { native } from '../lib/native';
import { noteIgnored } from '../lib/ignored';
import { contextUsageKey } from '../store/contextUsage';
import { useEffectOn } from '../lib/effects';
import { currentFamily, HARNESS_TRAITS } from '../harness/family';
import type { ContextSnapshot } from '../lib/native/context';

/** Snapshots by owner, as main last published or answered them. */
const cache = new Map<string, ContextSnapshot>();
const listeners = new Set<() => void>();
/** Owners asked for once this run: main pushes every change after that. */
const asked = new Set<string>();
/** Where the last ask for an owner stands, while it has no snapshot to show: running, or answered with nothing. */
const asks = new Map<string, 'reading' | 'unavailable'>();
/** Only the latest breakdown request may publish its answer or change its owner's pending state. */
const reads = new Map<string, symbol>();
let subscribed = false;
const notify = () => {
  for (const fn of listeners) fn();
};

function put(s: ContextSnapshot | null | undefined) {
  if (!s || typeof s.owner !== 'string') return;
  const prev = cache.get(s.owner);
  // an answer that crossed a newer push never replaces it
  if (prev && prev.at > s.at) return;
  cache.set(s.owner, s);
  if (s.used !== null) asks.delete(s.owner);
  notify();
}

function subscribe(fn: () => void) {
  if (!subscribed) {
    subscribed = true;
    native.context.onSnapshot((e) => put(e?.snapshot));
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Ask main for an owner's snapshot: a harness with a breakdown reads it afresh when there is none or it is stale (a
 * session not running answers with what it has), the others answer with what main holds.
 */
export function askContext(owner: string, breakdown: boolean, detail: 'summary' | 'full' = 'summary'): Promise<ContextSnapshot | null> {
  const s = cache.get(owner);
  const read = breakdown && (detail === 'full' || !s || s.quality !== 'breakdown' || s.stale !== null);
  const request = Symbol();
  if (read) reads.set(owner, request);
  const current = () => !read || reads.get(owner) === request;
  // an answer with usable tokens clears the mark (put); an empty answer leaves it unavailable
  const mark = (state: 'reading' | 'unavailable') => {
    if (!current() || cache.get(owner)?.used != null || asks.get(owner) === state) return;
    asks.set(owner, state);
    notify();
  };
  // only a read can come back empty: a harness without a breakdown just has not reported yet
  if (read) mark('reading');
  return (read ? native.context.refresh(owner, detail) : native.context.get(owner)).then(
    (answer) => {
      if (current()) {
        put(answer);
        if (read && answer?.used == null) mark('unavailable');
      }
      return cache.get(owner) ?? null;
    },
    (error) => {
      if (!current()) return cache.get(owner) ?? null;
      if (read) mark('unavailable');
      throw error;
    },
  );
}

/** Where an owner's ask stands while it has no snapshot: 'reading', 'unavailable' (answered with nothing), or null. */
export function useContextAsk(owner: string | null): 'reading' | 'unavailable' | null {
  return useSyncExternalStore(subscribe, () => (owner ? (asks.get(owner) ?? null) : null));
}

/** The current owner of a chat's context ([chat, harness, native id]) and whether its harness says what fills it. */
export function useContextOwner(chatId: string | null): { owner: string; breakdown: boolean } | null {
  const segments = useStore((s) => (chatId ? s.segments?.[chatId] : undefined));
  if (!chatId) return null;
  return {
    owner: contextUsageKey(segments, chatId),
    breakdown: HARNESS_TRAITS[currentFamily(segments, chatId)].contextBreakdown === 'full',
  };
}

/**
 * The chat's snapshot, or null while main has none for its current owner: a switch never shows the previous owner's,
 * even for one frame. The first display of an owner asks main once; a harness with a breakdown that has none yet (its
 * session was not running) is asked again whenever the chat's turn changes state, as its session comes up. A failed
 * ask leaves it unknown, never zero, and is asked again by the next display.
 */
export function useContextSnapshot(chatId: string | null, purpose: string): ContextSnapshot | null {
  const own = useContextOwner(chatId);
  const owner = own?.owner ?? null;
  const snapshot = useSyncExternalStore(subscribe, () => (owner ? (cache.get(owner) ?? null) : null));
  const status = useStore((s) => (chatId ? (s.runtime?.[chatId]?.turns?.at(-1)?.status ?? null) : null));
  const waiting = !!own?.breakdown && snapshot?.quality !== 'breakdown';
  const key = owner && (waiting ? JSON.stringify([owner, status]) : owner);
  useEffectOn([key], () => {
    if (!own || !key || asked.has(key)) return;
    // the owner counts as asked too: once its breakdown comes, nothing is asked again (main pushes every change)
    asked.add(key).add(own.owner);
    askContext(own.owner, own.breakdown).catch((error) => {
      asked.delete(key);
      asked.delete(own.owner);
      noteIgnored(purpose, error);
    });
  });
  return snapshot;
}

/** For tests: forget every snapshot and ask. */
export function resetContextSnapshots() {
  cache.clear();
  asked.clear();
  asks.clear();
  reads.clear();
  listeners.clear();
  subscribed = false;
}
