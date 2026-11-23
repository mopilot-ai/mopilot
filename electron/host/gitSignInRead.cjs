// Whether git can sign in to a repository host on a machine, read from the machine's Host when the window asks (host.status `signIn`, host/src/gitSignIn.mjs): one short connection per ask, closed after, never a poll; anything but a clear answer is 'unknown'.

const { helloParams } = require('../../shared/host/schema.mjs');

/** Which repository hosts the app asks about. */
const HOSTS = ['github.com'];
const STATES = new Set(['yes', 'no', 'unknown']);
/** The Host answers within this or the reading is 'unknown' (its own reading stops at 4 s). */
const READ_MS = 8000;

/**
 * @param {object} o
 * @param {(id: string) => Promise<{ call: (method: string, params?: object, opts?: { timeoutMs?: number }) => Promise<any>, close: () => void }>} o.open an authenticated connection to a machine's Host
 * @returns {(id: string) => Promise<Record<string, 'yes' | 'no' | 'unknown'>>} the answer per repository host; a machine that cannot be reached, an older Host, or a failed read says 'unknown' for each
 */
function createGitSignInRead({ open }) {
  return async (id) => {
    const unknown = Object.fromEntries(HOSTS.map((h) => [h, /** @type {const} */ ('unknown')]));
    try {
      const session = await open(id);
      try {
        // `host.status` is a request of the versioned protocol: its connection says hello first
        await session.call('host.hello', helloParams());
        const answered = (await session.call('host.status', { signIn: HOSTS }, { timeoutMs: READ_MS }))?.gitSignIn;
        return Object.fromEntries(HOSTS.map((h) => [h, STATES.has(answered?.[h]) ? answered[h] : 'unknown']));
      } finally {
        session.close();
      }
    } catch {
      return unknown;
    }
  };
}

module.exports = { createGitSignInRead, GIT_SIGNIN_HOSTS: HOSTS };
