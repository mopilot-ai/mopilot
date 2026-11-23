// When a machine's live connection dropped (Remote Run audit chat:C22): the connection to a machine tells at once when its tunnel or its Host goes away, seconds before the registry's 30 s heartbeat misses; the row says "Reconnecting…" from that moment until the connection is back or the registry calls the machine offline.
const { clock } = require('../platform/ports/clock.cjs');

/** A connection that dropped and has not come back this long is not a hiccup: the machine is offline (Remote Run #5135; it was 60 to 90 s, the registry's window counted from the last good heartbeat). */
const DROP_OFFLINE_MS = 30_000;

/**
 * @param {object} o
 * @param {() => void} o.onChange told when a machine's dropped state changed, so the list is sent again
 * @param {(id: string) => void} [o.onUp] told when a connection that dropped is back: the registry asks the machine now, so its row does not wait for the next heartbeat
 */
function createLinkWatch({ onChange, onUp = () => undefined }) {
  /** The machines whose connection has been online, and when each one's last dropped (ms). @type {Set<string>} */
  const up = new Set();
  /** @type {Map<string, number>} */
  const dropped = new Map();
  /** What each followed connection says it is now. @type {Map<string, string>} */
  const now = new Map();
  /** The timer that tells the list when a drop has lasted long enough to be offline. @type {Map<string, any>} */
  const timers = new Map();
  const stopTimer = (/** @type {string} */ id) => {
    clock.clearTimeout(timers.get(id));
    timers.delete(id);
  };
  return {
    /**
     * Follow a machine's connection; resolves to what ends the following.
     * @param {string} id @param {{ state: () => string, onState: (fn: (s: string) => void) => () => void }} host
     */
    watch(id, host) {
      now.set(id, host.state());
      if (host.state() === 'online') up.add(id);
      const off = host.onState((s) => {
        now.set(id, s);
        if (s === 'online') {
          up.add(id);
          if (dropped.delete(id)) stopTimer(id), onChange(), onUp(id);
          // a connection that was never up (still starting) has not dropped
        } else if (up.has(id) && !dropped.has(id)) {
          dropped.set(id, clock.now());
          timers.set(
            id,
            clock.setTimeout(() => (timers.delete(id), onChange()), DROP_OFFLINE_MS),
          );
          onChange();
        }
      });
      return () => {
        off();
        up.delete(id);
        dropped.delete(id);
        now.delete(id);
        stopTimer(id);
      };
    },
    /**
     * When the machine's connection dropped and has not come back; null while it is online (a heartbeat that failed on a busy Host does not make it reconnecting); undefined when no connection is followed, so the heartbeat is all there is to go by.
     * @param {string} id @returns {number | null | undefined}
     */
    droppedAt: (id) => dropped.get(id) ?? (now.get(id) === 'online' ? null : undefined),
  };
}

module.exports = { createLinkWatch, DROP_OFFLINE_MS };
