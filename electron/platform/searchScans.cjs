// A search box's newest search replaces its scan still running: one per window and box, for every harness's search.

/** A search reads at most this many transcripts, newest first, and starts no read after SEARCH_MS: a long history never stalls the box. */
const SEARCH_FILES = 400;
const SEARCH_MS = 2500;

/**
 * Who asks: the window (an IPC event's sender) and the search box in it (the renderer's `scope`), so a palette's next
 * search replaces only that palette's scan, and other boxes' and windows' go on.
 * @param {{ sender?: { id?: number } } | null | undefined} event
 * @param {unknown} scope
 */
const searchCaller = (event, scope) => `${event?.sender?.id ?? ''}:${String(scope ?? '')}`;

/**
 * Runs each caller's scans so that a newer one replaces the older: `scan(replaced)` checks `replaced()` before each
 * file it reads and stops (its caller has dropped its answer already).
 */
function searchScans() {
  /** @type {Map<unknown, object>} */
  const running = new Map();
  /**
   * @template T
   * @param {unknown} caller
   * @param {(replaced: () => boolean) => Promise<T>} scan
   * @returns {Promise<T>}
   */
  return async function run(caller, scan) {
    const token = {};
    running.set(caller, token);
    try {
      return await scan(() => running.get(caller) !== token);
    } finally {
      if (running.get(caller) === token) running.delete(caller);
    }
  };
}

module.exports = { searchCaller, searchScans, SEARCH_FILES, SEARCH_MS };
