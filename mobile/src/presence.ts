// What the phone knows of each paired computer's presence, from the relay's hello and its machine.presence events; lastSeen is the last moment the computer was known to be there.
export type MacPresence = 'online' | 'sleeping' | 'gone';
export type PairPresence = { state: MacPresence; lastSeen: number | null };
export type PresenceMap = Record<string, PairPresence>;

const STATES: ReadonlySet<unknown> = new Set(['online', 'sleeping', 'gone']);
export const isMacPresence = (value: unknown): value is MacPresence => STATES.has(value);

/** One pair's new entry: online is seen now; otherwise the time the relay gave, else the last time it was known to be online. */
function next(prev: PairPresence | undefined, state: MacPresence, at: unknown, now: number): PairPresence {
  if (state === 'online') return { state, lastSeen: now };
  if (typeof at === 'number' && Number.isFinite(at) && at > 0) return { state, lastSeen: at };
  return { state, lastSeen: prev?.lastSeen ?? null };
}

/** The relay's hello lists this phone's pairs with the computer's presence; a hello without it falls back to whether the computer is connected. */
export function presenceFromHello(prev: PresenceMap, hello: unknown, now: number): PresenceMap {
  const pairs = (hello as { pairs?: unknown })?.pairs;
  if (!Array.isArray(pairs)) return prev;
  const out = { ...prev };
  for (const p of pairs as Array<{ pair?: unknown; joined?: unknown; peerOnline?: unknown; presence?: unknown }>) {
    if (!p || typeof p.pair !== 'string' || !p.joined) continue;
    const state = isMacPresence(p.presence) ? p.presence : p.peerOnline ? 'online' : 'gone';
    out[p.pair] = next(prev[p.pair], state, undefined, now);
  }
  return out;
}

/** The pair the relay's hello lists as joined, or undefined. */
export function joinedPeer(hello: unknown, pairId: string) {
  const pairs = (hello as { pairs?: Array<{ pair: string; joined: boolean; peerOnline: boolean }> } | null)?.pairs;
  return Array.isArray(pairs) ? pairs.find((p) => p.pair === pairId && p.joined) : undefined;
}

/**
 * Presence across a connect. The relay adds the phone before it reads the presence for its hello, so every event on the socket is at least
 * as new as the hello; React Native can deliver the hello and an event in one batch, both before the connect's `await` resumes (#3248).
 * A pair an event spoke for since `begin` keeps that state when the hello is applied.
 */
export function presenceAcrossConnect() {
  let heard: Set<string> | null = null;
  return {
    begin() {
      heard = new Set();
    },
    event(prev: PresenceMap, pair: string, state: unknown, at: unknown, now: number): PresenceMap {
      if (isMacPresence(state)) heard?.add(pair);
      return presenceFromEvent(prev, pair, state, at, now);
    },
    hello(prev: PresenceMap, hello: unknown, now: number): PresenceMap {
      const out = presenceFromHello(prev, hello, now);
      for (const pair of heard ?? []) if (prev[pair]) out[pair] = prev[pair];
      heard = null;
      return out;
    },
  };
}

export function presenceFromEvent(prev: PresenceMap, pair: string, state: unknown, at: unknown, now: number): PresenceMap {
  if (!isMacPresence(state)) return prev;
  return { ...prev, [pair]: next(prev[pair], state, at, now) };
}

/** The line for a computer: what it is doing now and, when it is away, when it was last there. */
export function presenceLine(entry: PairPresence | undefined, now: number): string | null {
  if (!entry) return null;
  if (entry.state === 'online') return 'Online';
  const away = entry.state === 'sleeping' ? 'Asleep' : 'Not reachable';
  return entry.lastSeen === null ? away : `${away} · last seen ${ago(now - entry.lastSeen)}`;
}

function ago(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** The pill under the Chats title: Connected while the computer is there, else what it is doing and when it was last seen; `away` is true then. */
export function computerStatus(entry: PairPresence | undefined, now: number) {
  const away = entry && entry.state !== 'online' ? presenceLine(entry, now) : null;
  return { status: away ?? 'Connected', away: away !== null };
}
