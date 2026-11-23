// Owns what a Host connection does with a remembered "unknown client" answer: a pairing can happen after the answer (here or in another window), so a call that needs the Host's trust asks once more before the answer is shown.
const { noteIgnored } = require('../ignored.cjs');

/**
 * @param {object} o
 * @param {() => Error | null} o.unpaired the Host's remembered answer to this app's proof, or null
 * @param {() => Promise<void>} o.again authenticates and agrees again on the live connection
 * @param {() => void} o.live throws when the connection was disposed
 * @param {() => boolean} o.ready whether the connection is up
 * @param {() => Error} o.refuse the error of a call refused up front
 * @param {(method: string, params?: object) => Promise<any>} o.request the connection's request, with no trust check of its own
 * @param {(method: string, params?: object) => void} o.gate refuses a call the agreed protocol does not allow
 */
function createTrust({ unpaired, again, live, ready, refuse, request, gate }) {
  /** @type {Promise<void> | null} */
  let asking = null;
  /** One new agreement for every call that meets the stale answer at the same time; a failure is the connection's (a drop tells everyone). */
  const reagree = () =>
    (asking ??= again()
      .catch((/** @type {unknown} */ e) => noteIgnored('ask the Host again whether it knows this app', e))
      .finally(() => {
        asking = null;
      }));
  /** Asks the Host once more when its "unknown client" answer is remembered; throws it only when it is the Host's answer now. */
  async function trusted() {
    const stale = unpaired();
    if (!stale) return;
    // the Host's answer can have been outlived by a pairing, and a key this app could not read by the keychain being unlocked: the next user action asks again, whoever gave the answer
    await reagree();
    live();
    if (!ready()) throw refuse();
    const now = unpaired();
    if (now) throw now;
  }
  /** A call that passed needs(): sent as it is when the Host trusts this app, else after one new agreement. @param {string} method @param {object} [params] */
  async function trustedRequest(method, params) {
    if (unpaired()) {
      await trusted();
      gate(method, params);
    }
    return request(method, params);
  }
  return { trusted, trustedRequest };
}

module.exports = { createTrust };
