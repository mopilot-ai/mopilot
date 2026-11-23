// The seam between the remote service and the sealed channel: what the service needs from a transport, and an in-memory pair of ends for tests.

/**
 * One decrypted protocol message (design/mobile-remote protocol.html, "a sealed message, after decryption").
 * @typedef {object} RemoteMessage
 * @property {string} id the sender's message id; a request's id is also its idempotency id
 * @property {number} t sender clock, ms
 * @property {'request' | 'reply' | 'event' | 'ack'} kind
 * @property {string} [method] request: 'chat.send', ...
 * @property {any} [params] request
 * @property {string} [inReplyTo] reply: the request's id
 * @property {boolean} [ok] reply
 * @property {any} [result] reply, when ok
 * @property {{ code: string, message: string }} [error] reply, when not ok
 * @property {string} [ev] event: 'session.patch', 'items.append', ...
 * @property {string} [chatId] event
 * @property {number} [rev] event
 * @property {number} [feedSeq] item event: watermark of the feed snapshot that already includes it
 * @property {boolean} [live] item event: whether it belongs to the current live turn; false requests a history refresh
 * @property {string | null} [turnId] item event: the originating turn, when the harness supplies it
 * @property {boolean} [started] turn event: a new run, including reuse of an id after completion
 * @property {any} [patch] event
 */

/** @typedef {'online' | 'sleeping' | 'gone'} Presence */

/**
 * The Mac end of the sealed channel, as the service sees it. The real one (electron/remote/channel.cjs plus relayClient.cjs)
 * decrypts, replay-guards and hands over plain messages; the service never sees keys, counters or the relay.
 * @typedef {object} RemoteTransport
 * @property {(pairId: string, msg: RemoteMessage) => Promise<void>} send seals and sends one message to the pair's phone;
 *   rejects when the pair is unknown
 * @property {(fn: (pairId: string, msg: RemoteMessage) => void) => () => void} onMessage a message from a pair's phone; returns unsubscribe
 * @property {() => string[]} pairs the paired devices' pair ids now
 * @property {(fn: (pairs: string[]) => void) => () => void} onPairsChanged the list changed (paired, unpaired); returns unsubscribe
 * @property {(pairId: string) => Presence} presence whether the pair's phone is reachable now
 */

const copy = (/** @type {RemoteMessage} */ msg) => JSON.parse(JSON.stringify(msg));

/**
 * Two connected ends in memory: `mac` is a RemoteTransport for the service; `phone(pairId)` is the phone's end, which
 * sends requests to the service and receives its replies and events. Messages are JSON-copied, as the wire does.
 */
export function createMemoryLink() {
  /** @type {Set<string>} */
  const paired = new Set();
  /** @type {Map<string, Presence>} */
  const states = new Map();
  /** @type {Set<(pairId: string, msg: RemoteMessage) => void>} */
  const macListeners = new Set();
  /** @type {Set<(pairs: string[]) => void>} */
  const pairListeners = new Set();
  /** @type {Map<string, Set<(msg: RemoteMessage) => void>>} */
  const phoneListeners = new Map();
  const changed = () => {
    const now = [...paired];
    for (const fn of [...pairListeners]) fn(now);
  };

  /** @type {RemoteTransport} */
  const mac = {
    async send(pairId, msg) {
      if (!paired.has(pairId)) throw new Error(`Unknown pair ${pairId}`);
      const wire = copy(msg);
      for (const fn of [...(phoneListeners.get(pairId) ?? [])]) fn(wire);
    },
    onMessage(fn) {
      macListeners.add(fn);
      return () => void macListeners.delete(fn);
    },
    pairs: () => [...paired],
    onPairsChanged(fn) {
      pairListeners.add(fn);
      return () => void pairListeners.delete(fn);
    },
    presence: (pairId) => states.get(pairId) ?? 'gone',
  };

  return {
    mac,
    /** Pairs a phone; its end is then reachable through phone(pairId). */
    addPair(/** @type {string} */ pairId, /** @type {Presence} */ presence = 'online') {
      paired.add(pairId);
      states.set(pairId, presence);
      changed();
    },
    /** Unpairs it: later sends to it reject. */
    removePair(/** @type {string} */ pairId) {
      paired.delete(pairId);
      states.delete(pairId);
      phoneListeners.delete(pairId);
      changed();
    },
    setPresence(/** @type {string} */ pairId, /** @type {Presence} */ presence) {
      if (paired.has(pairId)) states.set(pairId, presence);
    },
    /** The phone's end of one pair. */
    phone(/** @type {string} */ pairId) {
      return {
        /** Sends a message to the Mac's service; rejects after the pair is gone. */
        async send(/** @type {RemoteMessage} */ msg) {
          if (!paired.has(pairId)) throw new Error(`Unknown pair ${pairId}`);
          const wire = copy(msg);
          for (const fn of [...macListeners]) fn(pairId, wire);
        },
        onMessage(/** @type {(msg: RemoteMessage) => void} */ fn) {
          const set = phoneListeners.get(pairId) ?? new Set();
          phoneListeners.set(pairId, set);
          set.add(fn);
          return () => void set.delete(fn);
        },
      };
    },
  };
}
