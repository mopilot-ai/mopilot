// The paired Mac's link as every screen draws it: Connected or Offline, its real name, and the baseline's offline words (no page changes shape).
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { MobileRuntime, MobileSnapshot } from './contracts';
import { followMachines, withDirect, type Machine } from './remote/machines';
import { useDirect } from './remote/useDirect';

/** A computer as a row or a chip shows it: the live connection, reachable but not connected, or away. */
export type MacState = 'connected' | 'available' | 'offline';
export type MacLink = {
  pairId: string | null;
  /** The computer's own name ("MacBook Pro"); "Computer" only when the pair never told one. */
  name: string;
  state: MacState;
  /** True only while this phone is connected to the computer and the relay has not said it went away: what sends and approvals need. */
  online: boolean;
  /** The Computers chip: the name, and " · Offline" while it is away. */
  chip: string;
  /** The word beside a computer's row in Settings. */
  word: string;
};

export const MAC_WORD: Record<MacState, string> = { connected: 'Connected', available: 'Available', offline: 'Offline' };
/** A Mac that told the relay it is going to sleep says so; one that is simply gone may have quit or lost its network, and nothing here can tell which. */
export const macWord = (state: MobileSnapshot, pairId: string) => {
  const mac = macState(state, pairId);
  return mac === 'offline' && state.presence[pairId]?.state === 'sleeping' ? 'Asleep' : MAC_WORD[mac];
};
/** Under a message the phone holds until the Mac is back (the outbox). */
export const QUEUED_LINE = 'Will send when your computer reconnects';
/** Under an approval card whose buttons are disabled while the Mac is away. */
export const APPROVAL_OFFLINE_LINE = 'Your computer is offline. Answer here once it reconnects, or on the computer.';

const away = (state: MobileSnapshot, pairId: string) => {
  const presence = state.presence[pairId]?.state;
  return presence === 'sleeping' || presence === 'gone';
};

/** One paired computer's state: connected is the selected pair while the phone is online and the relay has not said it left. */
export function macState(state: MobileSnapshot, pairId: string): MacState {
  if (state.phase === 'online' && state.selectedPair === pairId) return away(state, pairId) ? 'offline' : 'connected';
  return state.presence[pairId]?.state === 'online' ? 'available' : 'offline';
}

/** The link to `pairId`, by default the selected computer (else the first paired one, which a reconnect brings back). */
export function macLink(state: MobileSnapshot, pairId: string | null = state.selectedPair ?? state.pairs[0]?.pairId ?? null): MacLink {
  const name = state.pairs.find((pair) => pair.pairId === pairId)?.name?.trim() || 'Computer';
  const mac: MacState = pairId ? macState(state, pairId) : 'offline';
  return {
    pairId,
    name,
    state: mac,
    online: mac === 'connected',
    chip: mac === 'connected' ? name : `${name} · Offline`,
    word: pairId ? macWord(state, pairId) : MAC_WORD[mac],
  };
}

/** The phone is making its first try at a computer by itself (the app just opened): nothing has failed yet, so nothing is said about a lost connection. */
export const connectingNow = (state: MobileSnapshot) =>
  state.phase === 'offline' && state.reconnect?.attempt === 0 && state.reconnect.nextAt === null && !state.error;

/** Signed in with a paired Mac that is not connected (and not on its first try): pages keep their shape, only states turn gray. */
export const awayFromMac = (state: MobileSnapshot) =>
  !!state.user && state.pairs.length > 0 && state.phase === 'offline' && !connectingNow(state);

/** Outside a provider (a screen drawn alone, as in a component test) the Mac counts as connected, so nothing is disabled by default. */
const CONNECTED: MacLink = { pairId: null, name: 'Computer', state: 'connected', online: true, chip: 'Computer', word: 'Connected' };
const MacLinkContext = createContext<MacLink>(CONNECTED);

type Machines = { machines: Machine[] | null; want: () => () => void };
const NONE: Machines = { machines: null, want: () => () => undefined };
const MachinesContext = createContext<Machines>(NONE);

/**
 * The Mac's machines while it is connected and some screen shows them; null otherwise, and on a Mac without Host access.
 * Nothing is asked of the Mac until a screen calls useMachines(), and a new connection reads them again.
 */
function useFollowedMachines(runtime: MobileRuntime | undefined, state: MobileSnapshot): Machines {
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [wanted, setWanted] = useState(0);
  const want = useCallback(() => {
    setWanted((n) => n + 1);
    return () => setWanted((n) => n - 1);
  }, []);
  const connected = state.phase === 'online' ? `${state.generation}:${state.selectedPair}` : null;
  const shown = wanted > 0;
  useEffect(() => {
    setMachines(null);
    if (!runtime || !connected || !shown) return;
    return followMachines(runtime, setMachines);
  }, [runtime, connected, shown]);
  // the phone's own paths join the Mac's list: they stay when the Mac is away (X3)
  const direct = useDirect(runtime);
  // the one fact the phone cannot read from its own path: which machines the Mac reaches now, so a Host that does not answer while the Mac reaches it is enrolled again (#4721)
  const macSays = direct?.macSays;
  useEffect(() => macSays?.((machines ?? []).filter((m) => m.status === 'online').map((m) => m.id)), [macSays, machines]);
  return useMemo(() => ({ machines: direct ? withDirect(machines, direct.facts) : machines, want }), [machines, want, direct]);
}

/** Set once by the app from its snapshot; every row, header, transcript note and approval card below reads the same link and machines. */
export function MacLinkProvider({ state, runtime, children }: { state: MobileSnapshot; runtime?: MobileRuntime; children?: ReactNode }) {
  const machines = useFollowedMachines(runtime, state);
  return createElement(
    MacLinkContext.Provider,
    { value: macLink(state) },
    createElement(MachinesContext.Provider, { value: machines }, children),
  );
}

/** The selected Mac's link, for a glyph that turns gray, a chip that says Offline, a queued note or a disabled approval. */
export const useMacLink = () => useContext(MacLinkContext);

/**
 * Every machine the Mac runs chats on (id "local" is the Mac itself, the rest its Hosts), with the Mac's own `line` and `tone`;
 * null while not connected or when the Mac has no Host access, so a screen hides its machines then. The Mac is asked only while
 * at least one screen that calls this is mounted.
 */
export function useMachines() {
  const { machines, want } = useContext(MachinesContext);
  useEffect(() => want(), [want]);
  return machines;
}
