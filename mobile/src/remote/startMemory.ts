// What the phone remembers of a chat it asked the computer to start, past the screen that asked: the start id, so asking again is the same start and never a second chat, and whether the answer was lost.
import type { MobileRuntime } from '../contracts';

type Memory = { key: string; id: string; lost: boolean };
const starts = new WeakMap<MobileRuntime, Memory>();

export const startMemory = {
  /** The id for these picks: the one already used when they are the same (a retry), else a new one. */
  idFor(runtime: MobileRuntime, key: string, fresh: () => string) {
    const known = starts.get(runtime);
    if (known?.key === key) return known.id;
    const next = { key, id: fresh(), lost: false };
    starts.set(runtime, next);
    return next.id;
  },
  /** The answer to the start was lost as the connection went: the chat may exist. */
  markLost(runtime: MobileRuntime, expectedId?: string) {
    const known = starts.get(runtime);
    if (known && (expectedId === undefined || known.id === expectedId)) known.lost = true;
  },
  /** Whether the last start's answer was lost and the person has not looked yet. */
  lost(runtime: MobileRuntime) {
    return starts.get(runtime)?.lost === true;
  },
  /** The start is over (it opened a chat, or failed for a reason that says nothing was started). */
  clear(runtime: MobileRuntime, expectedId?: string) {
    if (expectedId === undefined || starts.get(runtime)?.id === expectedId) starts.delete(runtime);
  },
  /** A new attempt: whatever was lost is being tried again under the same id. */
  retrying(runtime: MobileRuntime) {
    const known = starts.get(runtime);
    if (known) known.lost = false;
  },
};
