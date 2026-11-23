// A promise that gives up: rejects when the work does not settle in time, and always clears its timer.

/**
 * `promise`, or a rejection with `message` (an Error made when it fires) once `ms` pass. The timer is cleared as soon as
 * either side settles; `unref` keeps it from holding the process open.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @param {{ unref?: boolean }} [opts]
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, message, { unref = false } = {}) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    if (unref) timer.unref?.();
  });
  return /** @type {Promise<T>} */ (Promise.race([promise, late]).finally(() => clearTimeout(timer)));
}

module.exports = { withTimeout };
