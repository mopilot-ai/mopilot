// The commands a chat has in flight on the Host's Chromium (package 2.6). Chromium never answers a command on a session it detached, so a tab
// or a frame let go (Stop, a detach, a crash, the chat ending) fails what is waiting on it at once; otherwise the Mac's call would stay pending for good.

/** @typedef {{ targetId: string, sessionId: string, reject: (error: Error) => void }} Waiter */

/** @param {(why: string) => Error} makeError the error a let-go command fails with */
export function createWaiters(makeError) {
  /** @type {Set<Waiter>} */
  const waiting = new Set();
  /** @param {(w: Waiter) => boolean} match @param {string} why */
  const fail = (match, why) => {
    for (const waiter of [...waiting]) if (match(waiter)) waiter.reject(makeError(why));
  };
  return {
    /**
     * `work` as it settles, or the error a let-go gives first. The first outcome stands.
     * @template T
     * @param {string} targetId the tab the command runs on
     * @param {string} sessionId the CDP session it runs in
     * @param {Promise<T>} work
     * @returns {Promise<T>}
     */
    guard(targetId, sessionId, work) {
      return new Promise((resolve, reject) => {
        const waiter = { targetId, sessionId, reject };
        waiting.add(waiter);
        work.then(resolve, reject).finally(() => waiting.delete(waiter));
      });
    },
    /** The tab's sessions are gone: everything still waiting on the tab fails. @param {string} targetId @param {string} why */
    letGo: (targetId, why) => fail((w) => w.targetId === targetId, why),
    /** One session (a frame's) is gone: what waits on it fails. @param {string} sessionId @param {string} why */
    letGoSession: (sessionId, why) => fail((w) => w.sessionId === sessionId, why),
    /** The chat is gone: everything it still waits on fails. @param {string} why */
    letGoAll: (why) => fail(() => true, why),
  };
}
