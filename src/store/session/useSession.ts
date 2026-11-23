// This window's copy of each chat's SessionState (main holds the real one: electron/session/state.cjs).
// A chat's copy starts from a snapshot and then follows main's patches in rev order; a gap in rev
// takes a new snapshot. Components read it with useSession(chatId); other code with sessionOf().
import { useEffect } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { schedulePaint } from '../../lib/streamNotifications';
import { native } from '../../lib/native';
import { noteIgnored } from '../../lib/ignored';
import {
  EMPTY_SESSION,
  applySessionPatch,
  takeSnapshot,
  withGoalClock,
  type SessionPatch,
  type SessionState,
  type WindowSessionState,
} from './sessionState';

export const useSessions = create<{ sessions: Record<string, WindowSessionState>; loaded: Record<string, boolean> }>(() => ({
  sessions: {},
  loaded: {},
}));

const fetching = new Map<string, Promise<void>>();
const requiredRevs = new Map<string, number>();

/** Take main's snapshot once at a time; a newer gap during the fetch may need a follow-up. */
export function refreshSession(chatId: string, minimumRev = 0): Promise<void> {
  requiredRevs.set(chatId, Math.max(minimumRev, requiredRevs.get(chatId) ?? 0));
  const cur = fetching.get(chatId);
  if (cur !== undefined) return cur;
  const p = (async () => {
    for (;;) {
      const requestedRev = requiredRevs.get(chatId)!;
      const snap = await native.session.snapshot(chatId);
      if (!snap) return;
      // patches held for the frame are older than this snapshot's request and newer than the stored copy: apply them first
      flushSessionPatches();
      useSessions.setState((s) => ({
        sessions: { ...s.sessions, [chatId]: takeSnapshot(s.sessions[chatId], snap) },
        loaded: { ...s.loaded, [chatId]: true },
      }));
      // Only a gap observed after this request began warrants another request. A missing or
      // stale answer from main alone must not start an unbounded retry loop.
      const requiredRev = requiredRevs.get(chatId)!;
      if (requiredRev <= requestedRev || sessionOf(chatId).rev >= requiredRev) return;
    }
  })()
    // the next ensureSession or patch gap asks main again
    .catch((error) => noteIgnored("take main's snapshot of a chat's session", error))
    .finally(() => {
      fetching.delete(chatId);
      requiredRevs.delete(chatId);
    });
  fetching.set(chatId, p);
  return p;
}

/** The chat's state once this window has it. */
export function loadSession(chatId: string): Promise<void> {
  return useSessions.getState().sessions[chatId] ? Promise.resolve() : refreshSession(chatId);
}

/** Make sure this window follows the chat. */
export function ensureSession(chatId: string) {
  // cannot reject: refreshSession records a failed snapshot, and the next ensureSession or patch gap asks again
  if (!useSessions.getState().sessions[chatId]) void refreshSession(chatId);
}

// Patches are applied to `held` as they arrive (so rev order, gaps and stale patches are judged as before) and the
// store hears of all of a frame's chats at once: progress, tasks and app thumbnails patch many chats every second.
const held = new Map<string, WindowSessionState>();
let cancelPaint: (() => void) | undefined;

/** Commits the patches held for the next paint now. */
export function flushSessionPatches() {
  cancelPaint?.();
  cancelPaint = undefined;
  if (!held.size) return;
  const changed = Object.fromEntries(held);
  held.clear();
  useSessions.setState((s) => ({ sessions: { ...s.sessions, ...changed } }));
}

function onPatch(p: SessionPatch) {
  const next = applySessionPatch(held.get(p.chatId) ?? useSessions.getState().sessions[p.chatId], p);
  if (next === 'gap') return void refreshSession(p.chatId, p.rev);
  if (!next) return;
  held.set(p.chatId, next);
  cancelPaint ??= schedulePaint(flushSessionPatches);
}

let started = false;
export function startSessions() {
  if (started) return;
  started = true;
  native.session.onPatch(onPatch);
}

/**
 * The chat's state as this window last heard it, patches held for the next frame included: for code outside a render.
 * A component reads it with useSession or useSessionField, the committed copy that re-renders it (#2847).
 */
export function sessionOf(chatId: string | null | undefined): SessionState {
  return (chatId && (held.get(chatId) ?? useSessions.getState().sessions[chatId])) || EMPTY_SESSION;
}

export function useSession(chatId: string | null | undefined): WindowSessionState {
  useEffect(() => {
    if (chatId) ensureSession(chatId);
  }, [chatId]);
  return useSessions((s) => (chatId && s.sessions[chatId]) || EMPTY_SESSION);
}

/** One part of the chat's state: the component draws again only when that part changes (a shallow comparison of what `pick` returns). */
export function useSessionField<T>(chatId: string | null | undefined, pick: (session: SessionState) => T): T {
  useEffect(() => {
    if (chatId) ensureSession(chatId);
  }, [chatId]);
  return useSessions(useShallow((s) => pick((chatId && s.sessions[chatId]) || EMPTY_SESSION)));
}

/** Distinguish the placeholder from a real snapshot, whose revision may also be zero. */
export function useSessionLoaded(chatId: string | undefined): boolean {
  return useSessions((s) => !!chatId && !!s.loaded?.[chatId]);
}

/** A write reply is newer than any read already in flight; recovery must read after it. */
function refreshAfterWrite(chatId: string): Promise<void> {
  const pending = fetching.get(chatId);
  return pending === undefined ? refreshSession(chatId) : pending.then(() => refreshSession(chatId));
}

/**
 * Set keys windows own (plan, permission, goal, pendingSwitch). The copy shows them at once, at the
 * same rev; main's patch follows. Resolves true when main took it as a change (false: already so),
 * so a side effect of the change (a notification) happens in one window only.
 */
export function setSession(
  chatId: string,
  partial: Partial<Pick<SessionState, 'plan' | 'permission' | 'goal' | 'pendingSwitch' | 'modality' | 'scheduled'>>,
): Promise<boolean> {
  flushSessionPatches();
  useSessions.setState((s) => {
    const cur = s.sessions[chatId];
    return { sessions: { ...s.sessions, [chatId]: withGoalClock(cur, { ...(cur ?? EMPTY_SESSION), ...partial }) } };
  });
  // cannot reject: refreshSession records a failed snapshot
  if (!useSessions.getState().sessions[chatId]?.rev) void refreshSession(chatId);
  // main may keep more than the window sent (a goal paused at quit says so): when it saw no change,
  // its copy and this one can still differ, so take its copy again
  return native.session
    .patch(chatId, partial)
    .then((changed) => (changed || void refreshAfterWrite(chatId), changed))
    .catch(() => {
      // A failed reply is not confirmation of the optimistic state (main may or may not have
      // applied it). Read main's copy; revision ordering keeps newer pushed changes intact.
      void refreshAfterWrite(chatId);
      return false;
    });
}
