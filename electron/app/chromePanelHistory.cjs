// A chat's saved history as the side panel and a paired phone read it: concurrent readers share one snapshot, and a read of a chat main is running asks for its turn open.

/**
 * Reads a chat's history through the peer runtime. Concurrent readers share a snapshot; events received after a read starts queue
 * one fresh snapshot.
 * @param {{ peerRuntime: any }} live
 */
function createHistoryReader(live) {
  const histories = new Map();
  /** Runs a read, failing it with the panel's wording once it has taken 30 s. @template T @param {() => Promise<T>} read */
  async function withinTime(read) {
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Reading this chat took too long. Try again.')), 30_000);
      timer.unref?.();
    });
    try {
      return await Promise.race([Promise.resolve().then(read), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The recent end of a chat's saved history, for a reader that wants only its last rows: `enough(turns)` says whether the turns
   * read hold them, and the read goes no further back (the cost is the end's, not the chat's). `earlierContentOmitted` says earlier
   * turns were left unread. Never shared with another read: its size is its asker's. A runtime that cannot read only the end reads all of it.
   * @param {string} chatId @param {{ open?: boolean, enough: (turns: any[]) => boolean }} o
   * @returns {Promise<{ turns: any[], earlierContentOmitted?: boolean }>}
   */
  function recentOf(chatId, { open = false, enough }) {
    const read = live.peerRuntime?.readHistory;
    if (typeof read?.recent !== 'function') return withinTime(() => live.peerRuntime.readHistory(chatId, { open }));
    return withinTime(() => read.recent(chatId, { open, enough }));
  }

  /**
   * `open`: main runs the chat's turn now, so its steps still going read as running on a harness whose saved history cannot say
   * so (Claude Code's transcript replays a call with no result as finished). A read that asks for it is not shared with one that
   * does not.
   */
  function historyOf(/** @type {string} */ chatId, /** @type {any} */ record, open = false) {
    const reader = live.peerRuntime;
    const key = JSON.stringify([record.segments, open]);
    const previous = histories.get(chatId);
    const same = previous?.record === record && previous.reader === reader && previous.key === key;
    if (same && !previous.started) return previous.promise;
    // Join the next snapshot once a native read has started; its caller may follow a newer event.
    const entry = { record, reader, key, started: false, promise: null };
    const begin = async () => {
      entry.started = true;
      return withinTime(() => reader.readHistory(chatId, { open }));
    };
    const promise = same ? previous.promise.then(begin, begin) : Promise.resolve().then(begin);
    entry.promise = promise;
    histories.set(chatId, entry);
    const settled = () => {
      if (histories.get(chatId) === entry) histories.delete(chatId);
    };
    void promise.then(settled, settled);
    return promise;
  }
  /** What the chat's saved history is now (its source's stamp), or null when its harness cannot say: rows made from it are not held between pages. @param {string} chatId */
  async function stampOf(chatId) {
    const stamp = live.peerRuntime?.readHistory?.stamp;
    return typeof stamp === 'function' ? stamp(chatId) : null;
  }
  return Object.assign(historyOf, { recent: recentOf, stamp: stampOf });
}

module.exports = { createHistoryReader };
