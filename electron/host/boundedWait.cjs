// Waits for a call to a machine for a while, not for ever: a machine that stopped answering (a cable out, a lid closed) keeps its connection looking up until its heartbeat fails, and what the person asked for here must not wait on it.
const { clock } = require('../platform/ports/clock.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** How long a deletion waits for its machine, to stop the chat there and to hand over the deletion, before it goes on as pending. */
const DELETION_WAIT_MS = 2000;

/**
 * The promise's own result or failure when it comes in time, `'late'` once `ms` have passed (the promise goes on; its later failure is noted, and nobody else's).
 * @template T
 * @param {Promise<T> | T} work
 * @param {number} [ms]
 * @returns {Promise<T | 'late'>}
 */
function within(work, ms = DELETION_WAIT_MS) {
  let gaveUp = false;
  const settled = Promise.resolve(work);
  settled.catch((error) => {
    if (gaveUp) noteIgnored('a call to a machine that had not answered in time failed', error);
  });
  /** @type {any} */
  let timer;
  // no time left (an earlier wait of the same bound used it): the work is not waited for at all, only started
  gaveUp = ms <= 0;
  const late = gaveUp
    ? Promise.resolve('late')
    : new Promise((resolve) => {
        timer = clock.setTimeout(() => {
          gaveUp = true;
          resolve('late');
        }, ms);
      });
  return Promise.race([settled, late]).finally(() => clock.clearTimeout(timer));
}

/**
 * One bound for several waits in a row: what is left of `ms` from now, each time it is asked.
 * @param {number} [ms]
 * @returns {() => number}
 */
function deadline(ms = DELETION_WAIT_MS) {
  const end = clock.now() + ms;
  return () => Math.max(0, end - clock.now());
}

module.exports = { within, deadline, DELETION_WAIT_MS };
