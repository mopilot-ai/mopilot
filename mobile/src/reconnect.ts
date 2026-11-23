// Brings the phone back to a computer that went away: one pair, one attempt at a time, waits that double to a cap, and a kick that retries now without ever running two attempts. An attempt the relay refused (at capacity, the account's device limit) waits the refusal's longer time instead.
import { RelayRefused, refusalWait } from '../../shared/remote/relayRefusal.mjs';

/** `refused`: the relay turned the phone away for now; the next attempt waits the refusal's time (15 s doubling to 5 minutes). */
export type ReconnectOutcome = 'connected' | 'retry' | 'refused' | 'stop';
export type ReconnectTiming = { baseMs: number; capMs: number; jitter: number; minGapMs: number };
/** `nextAt` is when the next attempt starts (epoch ms), null while one is running. */
export type ReconnectState = { pairId: string; attempt: number; nextAt: number | null } | null;

type Timer = ReturnType<typeof setTimeout>;

/** The relay is reachable but the computer is not there (asleep, off, or its app closed). */
export class Unreachable extends Error {}
/** The relay does not list the computer as joined to this phone: it was removed, and waiting will not bring it back. */
export class NotJoined extends Error {}
/** A newer connection took over while this one was opening; it is not a failure of the computer. */
export class ConnectionCancelled extends Error {
  constructor() {
    super('Connection cancelled');
  }
}

/** A relay refusal that ends by itself: it is full, or the account has its most devices connected. One switched off for the account does not. */
export const isPassingRefusal = (error: unknown): error is RelayRefused => error instanceof RelayRefused && error.refusal !== 'disabled';

/** A miss worth waiting out: the computer or the network is away, the relay is full, or the account service is briefly down. A removed pair or a refused account is not. */
export function isTransient(error: unknown) {
  if (error instanceof Unreachable || error instanceof TypeError || isPassingRefusal(error)) return true;
  if (error instanceof SyntaxError || (error instanceof Error && error.name === 'AbortError')) return true;
  return (
    error instanceof Error &&
    /^(relay (connection|disconnected|acknowledgement timed out)|Aborted$|Account service returned HTTP (5\d\d|408|425|429)|Network request failed$|fetch failed(: (The Internet connection appears to be offline|The network connection was lost|The request timed out|A server with the specified hostname could not be found|Could not connect to the server)\.?)?$)/.test(
      error.message,
    )
  );
}

export function createReconnector(o: {
  /** One try to open the pair; 'retry' schedules another, 'stop' and 'connected' end the loop. */
  attempt(pairId: string): Promise<ReconnectOutcome>;
  timing: ReconnectTiming;
  onChange(state: ReconnectState): void;
  now?: () => number;
  random?: () => number;
}) {
  const now = o.now ?? Date.now;
  const random = o.random ?? Math.random;
  let epoch = 0;
  let pairId: string | null = null;
  let failures = 0;
  /** Refusals by the relay in a row: what the wait after the next one grows from. */
  let refusals = 0;
  let timer: Timer | null = null;
  let nextAt: number | null = null;
  let running = false;
  /** A manual attempt has the pair: nothing is scheduled, but the pair still shows as being brought back. */
  let held = false;
  let lastStart = -Infinity;
  /** The computer announced itself while an attempt ran, whose answer may predate it: the next attempt goes at the gap, not after the wait. */
  let nudged = false;
  const publish = () => o.onChange(pairId ? { pairId, attempt: failures, nextAt } : null);
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    nextAt = null;
  };
  const wait = () => {
    const raw = Math.min(o.timing.capMs, o.timing.baseMs * 2 ** failures);
    return Math.max(0, Math.round(raw * (1 + o.timing.jitter * (2 * random() - 1))));
  };
  function schedule(ms: number) {
    clear();
    const owner = epoch;
    if (ms <= 0) return void run(owner);
    nextAt = now() + ms;
    timer = setTimeout(() => void run(owner), ms);
    // a pending retry must not keep a process alive; React Native timers have no unref
    (timer as { unref?: () => void }).unref?.();
    publish();
  }
  async function run(owner: number) {
    if (owner !== epoch || !pairId || running) return;
    clear();
    running = true;
    nudged = false;
    lastStart = now();
    publish();
    let outcome: ReconnectOutcome;
    try {
      outcome = await o.attempt(pairId);
    } catch {
      outcome = 'retry';
    }
    running = false;
    // another pair was asked for while this attempt ran: its first attempt goes now
    if (owner !== epoch) return void (pairId && !held && schedule(0));
    if (outcome !== 'retry' && outcome !== 'refused') return stop();
    failures++;
    const early = nudged;
    nudged = false;
    // a relay that turned the phone away is not asked again on the computer's word or after the short wait
    if (outcome === 'refused') return schedule(refusalWait(refusals++, random()));
    refusals = 0;
    schedule(early ? Math.max(0, lastStart + o.timing.minGapMs - now()) : wait());
  }
  function stop() {
    epoch++;
    held = false;
    nudged = false;
    clear();
    const was = pairId;
    pairId = null;
    failures = 0;
    refusals = 0;
    if (was) publish();
  }
  return {
    /** Starts bringing `pair` back: the first attempt after `delayMs` (the base wait by default, since the computer just went away). */
    start(pair: string, delayMs = o.timing.baseMs) {
      if (pairId === pair && !held) return;
      epoch++;
      held = false;
      nudged = false;
      failures = 0;
      pairId = pair;
      schedule(delayMs);
    },
    /** A tap connects now: timers stop and an attempt in flight is ignored; `start` resumes the wait if the tap fails, `stop` ends it. */
    hold(pair: string) {
      epoch++;
      clear();
      held = true;
      nudged = false;
      if (pairId !== pair) failures = 0;
      pairId = pair;
      publish();
    },
    /** The user or the OS asks to try now (foreground): the wait restarts from the base and an attempt in flight is left alone. */
    kick() {
      if (!pairId || running || held) return;
      failures = 0;
      epoch++;
      schedule(Math.max(0, lastStart + o.timing.minGapMs - now()));
    },
    /**
     * The computer says it is back (its presence turned online): the next attempt goes at the minimum gap instead of after the wait. The
     * failure count is kept, so a computer that keeps announcing itself and failing still backs off. While an attempt runs the nudge is
     * remembered (the attempt may have read the relay before the computer was back) and applied when it fails; a tap holding the pair, or
     * no pair being waited for, ignores it.
     */
    nudge() {
      if (!pairId || held) return;
      if (running) {
        nudged = true;
        return;
      }
      epoch++;
      schedule(Math.max(0, lastStart + o.timing.minGapMs - now()));
    },
    stop,
    pair: () => pairId,
  };
}
