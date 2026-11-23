// A relay socket the phone has heard nothing on for a while is asked to prove it is alive: one that does not answer is replaced through the catch-up, with the phone staying online.

/** Quiet this long (no frame, no answer) and the socket is asked. A stream or an answer keeps it from ever being asked. */
export const QUIET_MS = 10_000;
/** A socket that has not answered the question after this long is not alive: it can sit half open for minutes (Wi-Fi to cellular, a weak signal, a restarted relay) and deliver nothing. */
export const ANSWER_MS = 4000;

type Timers = { setEvery(fn: () => void, ms: number): unknown; clear(id: unknown): void };
const realTimers: Timers = {
  setEvery: (fn, ms) => {
    const id = setInterval(fn, ms);
    // a pending check must not keep a process alive
    (id as { unref?: () => void }).unref?.();
    return id;
  },
  clear: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};

export function createRelayLiveness(o: {
  /** A round trip the relay answers on the socket in use (an acknowledged request). */
  probe: () => Promise<unknown>;
  /** The socket of connection `owner` is not alive: replace it. */
  dead: (owner: number) => void;
  generation: () => number;
  /** Milliseconds since the relay last said anything on this socket. */
  quietFor: () => number;
  /** The relay answered: it was heard. */
  heard: () => void;
  timers?: Timers;
}) {
  const timers = o.timers ?? realTimers;
  let timer: unknown = null;
  let asking = false;
  const check = (owner: number) => {
    if (asking || owner !== o.generation() || o.quietFor() < QUIET_MS) return;
    asking = true;
    let limit: ReturnType<typeof setTimeout> | undefined;
    const silence = new Promise<never>((_, reject) => {
      limit = setTimeout(() => reject(new Error('relay did not answer')), ANSWER_MS);
    });
    Promise.race([o.probe(), silence])
      .then(
        () => o.heard(),
        () => {
          if (owner === o.generation()) o.dead(owner);
        },
      )
      .finally(() => {
        clearTimeout(limit);
        asking = false;
      });
  };
  return {
    /** Watches the connection `owner`; a new call replaces the watch. */
    start(owner: number) {
      this.stop();
      timer = timers.setEvery(() => check(owner), QUIET_MS);
    },
    stop() {
      if (timer !== null) timers.clear(timer);
      timer = null;
      asking = false;
    },
  };
}
