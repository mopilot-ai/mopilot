// Catching up on frames the inbox guard left to the relay: a fresh relay socket makes the relay resend what was never acked, while the session, its channels, the phase and everything on screen stay as they are. Only a reconnect that fails is visible.

/** A catch-up straight after another is not immediate: a backlog that makes no progress must not reconnect at full speed. */
export const CATCH_UP_GAP_MS = 5000;

export function createCatchUp(
  /** The first catch-up goes at once; a repeat just after the last one reports `undefined` from `delayMs`. */
  guard: { delayMs: () => number | undefined },
  /** Opens a fresh relay socket for the connection `owner`, whose inbox starts empty. */
  reopen: (owner: number) => Promise<unknown>,
  /** The reconnect itself failed: the ordinary connection-lost path, which is visible. */
  lost: (error: string) => void,
  generation: () => number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  return async (owner: number) => {
    if (guard.delayMs() === undefined) await sleep(CATCH_UP_GAP_MS);
    if (owner !== generation()) return;
    try {
      await reopen(owner);
    } catch (error) {
      if (owner === generation()) lost(error instanceof Error ? error.message : 'Connection lost. Reconnecting…');
    }
  };
}

/** An absence this long or longer, and the socket the OS kept for the app is not trusted: it can sit half open for seconds, delivering nothing, while the relay holds what the phone has not acked. */
export const REOPEN_AFTER_AWAY_MS = 3000;

/**
 * The app returned after a real absence while online: the relay's unacked frames are fetched on a fresh socket by the catch-up, once the
 * inbox is empty (frames waiting in it are applied first, never dropped or doubled). `drained` is told whenever a drain left the inbox empty.
 */
export function createReturnReopen(
  catchUp: (owner: number) => Promise<unknown>,
  /** Online, and not waiting for a computer to come back (the reconnector's own attempt covers that). */
  connected: () => boolean,
  /** Nothing queued or being applied. */
  idle: () => boolean,
  generation: () => number,
) {
  let wanted: number | null = null;
  const go = (owner: number) => {
    wanted = null;
    void catchUp(owner);
  };
  return {
    returned(awayMs: number) {
      if (awayMs < REOPEN_AFTER_AWAY_MS || !connected()) return;
      if (idle()) go(generation());
      else wanted = generation();
    },
    drained(owner: number) {
      if (wanted === owner) go(owner);
    },
  };
}

/**
 * What the phone does while it walks its counters forward to a computer far ahead of it (`phase`, from the session): it shows it, and when the walk is done reads everything
 * again, since the frames inside the gap are gone: `lost` brings the computer back by the path a computer that went away and returned takes.
 */
export function catchUpHandler(
  live: () => boolean,
  publish: (patch: { catchingUp: boolean }) => void,
  lost: (line: string, delayMs: number) => void,
) {
  return (phase: 'start' | 'done' | 'failed') => {
    // only a start needs the connection to be the live one: a walk that ends after a teardown, a switch or a sign-out must still clear the flag
    if (phase === 'start' && !live()) return;
    publish({ catchingUp: phase === 'start' });
    if (phase === 'done' && live()) lost('Catching up with your computer…', 0);
  };
}
