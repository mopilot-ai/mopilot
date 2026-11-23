// One approval card several tool calls wait on at once (a chat's calls share a site card): each call stops waiting when its
// own abort signal fires, and the card is withdrawn once every call waiting on it was aborted (#1865, approvals.cjs).

class SharedCard {
  /**
   * @param {(signal: AbortSignal) => Promise<any>} ask puts the card up; `signal` aborts when no call waits on it any more
   */
  constructor(ask) {
    this.ac = new AbortController();
    /** calls still waiting; a call with no signal can't be aborted, so it holds the card for good (Infinity) */
    this.waiters = 0;
    this.answer = ask(this.ac.signal);
  }

  /** Whether every call that waited on the card was aborted, so the card was withdrawn: its null is nobody's answer. */
  get withdrawn() {
    return this.ac.signal.aborted;
  }

  /**
   * The card's answer for one call, or `aborted()` thrown when the call's signal fires first. The caller checks that
   * `signal` has not fired yet.
   * @param {AbortSignal | null | undefined} signal
   * @param {() => Error} aborted
   */
  wait(signal, aborted) {
    if (!signal) {
      this.waiters = Number.POSITIVE_INFINITY;
      return this.answer;
    }
    this.waiters++;
    return new Promise((resolve, reject) => {
      const leave = () => {
        reject(aborted());
        if (--this.waiters === 0) this.ac.abort(signal.reason);
      };
      signal.addEventListener('abort', leave, { once: true });
      const done = () => signal.removeEventListener('abort', leave);
      this.answer.then(
        (answer) => (done(), resolve(answer)),
        (error) => (done(), reject(error)),
      );
    });
  }
}

module.exports = { SharedCard };
