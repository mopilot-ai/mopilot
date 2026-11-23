// Bounds the phone's queue of unprocessed relay frames: past the cap a frame is left to the relay's redelivery instead of ending the connection.

/** What to do with a frame: queue it, leave it to the relay (unacked, so it comes again after a reconnect), or give up because the relay would not resend it. */
export type Admission = 'keep' | 'leave' | 'lost';

/** A reconnect right after another one is not immediate: a backlog that makes no progress must not loop at full speed. */
const LOOP_MS = 5000;

/** The relay keeps at most 5000 frames per pair, so a whole backlog fits; the byte cap (counted over one connection) bounds memory when frames are large. */
export const INBOX_FRAMES = 5000;
export const INBOX_BYTES = 32 * 1024 * 1024;

/** What a queued frame holds, by its sealed box. */
export const frameSize = (frame: object) => {
  const box = (frame as { box?: unknown }).box;
  return typeof box === 'string' ? box.length : 0;
};

export function createInboxGuard(cap = INBOX_FRAMES, now: () => number = Date.now, byteCap = INBOX_BYTES) {
  let full = false;
  let held = 0;
  let lastAt = -Infinity;
  return {
    /**
     * Once the queue is full, this frame and every later one on the connection are left unprocessed and unacked: keeping a later one would skip the
     * counters of the dropped ones. A pairing reply (counter 0) is never resent by the relay, so it always goes in; a relay that does not keep frames until
     * acked would not resend any of them, so there the overflow is final.
     */
    admit(queued: number, ctr: number, resends: () => boolean, size = 0): Admission {
      if (ctr === 0) return 'keep';
      if (full) return 'leave';
      if (queued < cap && held + size <= byteCap) {
        held += size;
        return 'keep';
      }
      full = true;
      return resends() ? 'leave' : 'lost';
    },
    /** Whether frames were left to the relay on this connection. */
    tripped: () => full,
    /** A new connection starts empty. */
    reset() {
      full = false;
      held = 0;
    },
    /** The wait before reconnecting after this overflow: none the first time, the usual one when the last overflow was just now. */
    delayMs(): number | undefined {
      const at = now();
      const looping = at - lastAt < LOOP_MS;
      lastAt = at;
      return looping ? undefined : 0;
    },
  };
}
