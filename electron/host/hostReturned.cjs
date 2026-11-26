// A machine that comes back in the machine list is told what was continued without it: each snapshot is compared with the last, and a machine whose status changed to anything but offline is told (after the snapshot's own turn) while the app's switch runner is wired.
const { noteIgnored } = require('../ignored.cjs');

/**
 * @param {object} o
 * @param {{ switchRunner?: unknown } | undefined} o.live main's late-bound services: chats can be continued only once `switchRunner` is set
 * @param {(id: string) => Promise<unknown>} o.hostReturned tells a returning machine what was continued without it
 * @returns {(snapshot: { machines: { id: string, status: string }[] }) => void}
 */
function createHostReturned({ live, hostReturned }) {
  /** What each machine's status was at the last snapshot. @type {Map<string, string>} */
  const seen = new Map();
  return (snapshot) => {
    for (const m of snapshot.machines) {
      const was = seen.get(m.id);
      seen.set(m.id, m.status);
      if (m.status === 'offline' || was === m.status || !live?.switchRunner) continue;
      const id = m.id;
      // after the machines service has been returned to its first caller: this runs inside its own change callback
      queueMicrotask(() => hostReturned(id).catch((e) => noteIgnored('tell a returning host what was continued without it', e)));
    }
  };
}

module.exports = { createHostReturned };
