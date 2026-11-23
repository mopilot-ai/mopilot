// Publish only the latest asynchronous read, and stop reads and publications after disposal.

export function createLatestLoader<T, Args extends unknown[] = []>(
  read: (current: () => boolean, ...args: Args) => Promise<T>,
  publish: (value: T) => void,
  onError?: (error: unknown) => void,
) {
  let active = true;
  let version = 0;
  // the last load started: what `settled` waits for
  let newest: Promise<void> = Promise.resolve();
  const load = async (...args: Args) => {
    if (!active) return;
    const own = ++version;
    const current = () => active && own === version;
    let value: T;
    try {
      value = await read(current, ...args);
    } catch (error) {
      if (current()) onError?.(error);
      return;
    }
    if (current()) publish(value);
  };
  return {
    /** A complete live snapshot supersedes every read already in flight, but never revives a stopped owner. */
    push(value: T) {
      if (!active) return;
      version++;
      publish(value);
    },
    load(...args: Args) {
      newest = load(...args);
      return newest;
    },
    /**
     * Settles once the last load started has, including loads started while waiting: a caller that must show what
     * the newest read published (a switch waiting for its re-read) waits for this rather than for its own load,
     * which an overlapping newer load supersedes.
     */
    async settled() {
      let last: Promise<void>;
      do {
        last = newest;
        await last;
      } while (last !== newest);
    },
    /** Supersedes the reads in flight without stopping the owner (a view that unmounts and may mount again). */
    cancel() {
      version++;
    },
    stop() {
      active = false;
    },
  };
}
