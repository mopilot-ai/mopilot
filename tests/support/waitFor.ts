// Waits for a test condition on the real clock instead of a count of event-loop turns, so a loaded runner gets the
// same chance as an idle one; mocked timers do not stop it, and a timeout names what never happened.
import { performance } from 'node:perf_hooks';

// Captured at load: a test that mocks the timers later must not freeze the wait.
const realImmediate = globalThis.setImmediate;
const realTimeout = globalThis.setTimeout;
const now = performance.now.bind(performance);

/** Turns that run first, for in-memory work that settles at once; later rounds sleep so a slow read is not spun on. */
const QUICK_TURNS = 20;
const POLL_MS = 5;

export type WaitOptions = {
  /** Real milliseconds before the wait fails. */
  timeoutMs?: number;
  /** Runs between checks instead of yielding, for a condition that a fake clock must be advanced toward. */
  step?: () => unknown;
};

/**
 * Resolves with the condition's first truthy value; rejects when `timeoutMs` of real time pass first. The condition
 * may be async (an awaited file read, a socket query), and is checked once more at the deadline.
 */
export async function waitFor<T>(ok: () => T | Promise<T>, what = 'the condition', o: WaitOptions = {}): Promise<NonNullable<T>> {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const deadline = now() + timeoutMs;
  for (let turn = 0; ; turn++) {
    const value = await ok();
    if (value) return value as NonNullable<T>;
    if (now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    if (o.step) await o.step();
    else if (turn < QUICK_TURNS) await new Promise((r) => realImmediate(r));
    else await new Promise((r) => realTimeout(r, POLL_MS));
  }
}
