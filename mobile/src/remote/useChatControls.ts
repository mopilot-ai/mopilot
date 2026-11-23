// The open chat's controls (its menus, agents and what this Mac lets the phone change), read once and again after a change, for the header's ⋯ and the composer's model pill alike.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Owned } from './client';
import { loadChatControls, type ChatControls } from './controls';

/** A pick the person made in the chat's model sheet, shown on the controls until the Mac's own read-back replaces it. */
type Pick = {
  apply: (controls: ChatControls) => ChatControls;
  /** The Mac answered the pick (accepted); a refused pick is not kept. */
  settled: boolean;
  /** The first read of the controls that counts as the Mac's read-back: one that began at or after this count of reads. */
  from: number;
  /** Which pick this is: an answer to an earlier one (a sheet left meanwhile) cannot settle or take back a later one. */
  token: number;
  /** The pick this one was shown on top of, which a refusal of this one brings back. */
  base?: Pick;
};
const picks = new Map<string, Pick>();
const watchers = new Set<() => void>();
const changed = () => watchers.forEach((watch) => watch());
let tokens = 0;

/**
 * What a pick shows before the Mac answers (#4986). The write's answer carries no controls on any Mac or Host, so the pick is an overlay
 * on the controls the phone last read: it goes when the Mac refuses it, or when a read that began after the Mac accepted it lands.
 * A read that began earlier cannot take it away, and a second pick shows on top of one still waiting for its read-back; refused, it
 * leaves that one showing.
 */
export const optimistic = {
  get: (chatId: string) => picks.get(chatId),
  /** Shows a pick; the token it returns is what its answer settles it with. */
  show(chatId: string, apply: Pick['apply']): number {
    const before = picks.get(chatId);
    const token = ++tokens;
    picks.set(chatId, {
      apply: before ? (c) => apply(before.apply(c)) : apply,
      settled: false,
      from: Infinity,
      token,
      ...(before && { base: before }),
    });
    changed();
    return token;
  },
  settle(chatId: string, token: number, saved: boolean) {
    const pick = picks.get(chatId);
    if (pick?.token !== token) return;
    if (saved) picks.set(chatId, { ...pick, settled: true });
    else if (pick.base) picks.set(chatId, pick.base);
    else picks.delete(chatId);
    changed();
  },
  /** The controls are being read again: a read with this count or a later one is the Mac's answer to a settled pick. */
  after(chatId: string, count: number) {
    const pick = picks.get(chatId);
    if (pick?.settled && pick.from === Infinity) picks.set(chatId, { ...pick, from: count });
  },
  /** A read of the controls landed; it began as read `count`. */
  landed(chatId: string, count: number) {
    const pick = picks.get(chatId);
    if (!pick?.settled || count < pick.from) return;
    picks.delete(chatId);
    changed();
  },
  drop(chatId: string) {
    if (picks.delete(chatId)) changed();
  },
};
const watch = (fn: () => void) => (watchers.add(fn), () => void watchers.delete(fn));

/**
 * Null while the read is out, and when the Mac cannot list the controls (too old, or the read failed): what shows them
 * greys out, and the chat says nothing of a read the person did not ask for. A read that answers after the chat
 * changed is dropped; `reload` reads again (after a pick).
 */
/** How many notes the chat's saved rows hold: a settled switch of agent adds one, so the controls are read again when it does. */
export const notesIn = (thread: { history: { role?: unknown }[] } | null | undefined) =>
  thread?.history.filter((row) => row.role === 'note').length ?? 0;

export function useChatControls(request: Owned, chatId: string, enabled = true, notes = 0) {
  const [state, setState] = useState<{
    chatId: string;
    controls: ChatControls;
  } | null>(null);
  // the words of a chat the phone has no controls for (a machine's own chat): the menu says so instead of asking for an update
  const [refused, setRefused] = useState<{
    chatId: string;
    words: string;
  } | null>(null);
  const [reads, setReads] = useState(0);
  const count = useRef(0);
  // this Mac's agents as the last read got them, and when it asked (a reuse keeps the time it was asked)
  const agents = useRef<{ chatId: string; harnesses: ChatControls['harnesses']; at: number } | null>(null);
  const pick = useSyncExternalStore(watch, () => picks.get(chatId));
  // leaving the chat drops a pick still waiting: the next visit reads what the Mac has; a sheet left meanwhile asks for no read here
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      optimistic.drop(chatId);
    };
  }, [chatId]);
  useEffect(() => {
    void reads; // read again after a change
    void notes; // or after the chat's agent moved
    if (!enabled) return;
    let live = true;
    const known = agents.current?.chatId === chatId ? agents.current : null;
    loadChatControls(request, chatId, known).then(
      (controls) => {
        if (!live) return;
        if (controls.harnesses.length && !controls.machine)
          agents.current = { chatId, harnesses: controls.harnesses, at: controls.harnesses === known?.harnesses ? known.at : Date.now() };
        setState({ chatId, controls });
        setRefused(null);
        optimistic.landed(chatId, reads);
      },
      (e: unknown) => {
        // the request keeps the original refusal as the cause of its own error (ownedRequest)
        const code = (e as { cause?: { code?: string } } | null)?.cause?.code;
        if (live && code === 'unsupported') setRefused({ chatId, words: (e as Error).message });
      },
    );
    return () => {
      live = false;
    };
  }, [request, chatId, reads, enabled, notes]);
  const reload = useCallback(() => {
    if (!alive.current) return;
    count.current += 1;
    optimistic.after(chatId, count.current);
    setReads(count.current);
  }, [chatId]);
  const read = state?.chatId === chatId ? state.controls : null;
  // what the person picked shows over what was read, marked while the Mac has not answered
  const shown = useMemo(
    () =>
      read && pick
        ? {
            ...pick.apply(read),
            ...(!pick.settled && { saving: true as const }),
            asRead: { agent: read.harness?.id, held: read.switching },
          }
        : read,
    [read, pick],
  );
  return {
    controls: shown,
    reload,
    unsupported: refused?.chatId === chatId ? refused.words : null,
  };
}
