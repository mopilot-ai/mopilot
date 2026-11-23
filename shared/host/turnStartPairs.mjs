// A turn start from a Host that names the turn but not what was asked (Codex, Claude Code): the Host's own `{ t: 'user', turnId, text }` item says it, before or after the start. This pairs them, so the turn is drawn and recorded as an ACP turn is.
/** Turns waiting for the other half, at most this many of each: a Host that never sends one cannot grow them without end. */
const KEPT = 64;

const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The user message of a turn, as an ACP turn start carries it. @param {string} turnId @param {string} text @param {string} [messageKey] @param {any} [full] */
const userOf = (turnId, text, messageKey, full) => ({
  ...(typeof messageKey === 'string' ? { messageKey } : {}),
  id: `u-${turnId}`,
  // the key of the message that asked for the turn is the id the window drew it under; a turn nobody keyed is its own
  clientId: typeof messageKey === 'string' ? messageKey : turnId,
  content: text ? [{ type: 'text', text, text_elements: [] }] : [],
  ...(isObject(full) ? full : {}),
});

/** @param {Map<string, any>} map @param {string} key @param {any} value */
function keep(map, key, value) {
  map.set(key, value);
  if (map.size > KEPT) map.delete(/** @type {string} */ (map.keys().next().value));
}

/**
 * One chat's pairing. `unasked` reads the sent input for a bare turn start. The caller settles the queued bubble only after applying that start.
 */
function createStartPairs(/** @type {{ unasked?: (key?: string) => string | undefined }} */ { unasked = () => undefined } = {}) {
  /** Turn starts waiting for what was asked. @type {Map<string, any>} */
  const held = new Map();
  /** What was asked, waiting for the turn start. @type {Map<string, { text: string, messageKey?: string, user?: any }>} */
  const said = new Map();
  /** Turns whose start carried its user message: the Host's user item for them (an ACP Host sends it after) says nothing new. @type {Map<string, true>} */
  const complete = new Map();
  /** Turns released with the text this Mac sent: the Host's user item for them is already shown. @type {Map<string, true>} */
  const filled = new Map();
  return {
    /** The Host's numbering changed: turn ids start again, so nothing waiting belongs to the new ones. */
    reset() {
      held.clear();
      said.clear();
      complete.clear();
      filled.clear();
    },
    /**
     * The events to apply for one item of the Host's stream, in order: a turn start that carries its user message as it is, one without it once the Host says what was asked (at once when it already did), and every other event as it is.
     * An event of a turn whose start is still held means the turn was not asked by anyone (the agent began it): the start goes first, with no user message.
     * @param {any} item the stream item @param {any} event the event it carries, or null
     * @returns {any[]}
     */
    take(item, event) {
      if (!event) {
        if (item?.t !== 'user' || typeof item.turnId !== 'string' || typeof item.text !== 'string') return [];
        if (complete.delete(item.turnId)) return [];
        if (filled.delete(item.turnId)) return [];
        const start = held.get(item.turnId);
        if (!start) {
          keep(said, item.turnId, { text: item.text, messageKey: item.key ?? item.clientId ?? item.user?.clientId, user: item.user });
          return [];
        }
        held.delete(item.turnId);
        return [{ ...start, user: userOf(item.turnId, item.text, item.key ?? item.clientId ?? item.user?.clientId, item.user) }];
      }
      if (event.kind === 'turnStart') {
        if (isObject(event.user)) {
          said.delete(event.turnId);
          keep(complete, event.turnId, true);
          return [event];
        }
        const text = said.get(event.turnId);
        if (text === undefined) {
          keep(held, event.turnId, event);
          return [];
        }
        said.delete(event.turnId);
        return [{ ...event, user: userOf(event.turnId, text.text, text.messageKey, text.user) }];
      }
      const start = held.get(event.turnId);
      if (!start) return [event];
      held.delete(event.turnId);
      const sent = unasked(start.messageKey);
      if (sent !== undefined) keep(filled, event.turnId, true);
      return [{ ...start, user: userOf(event.turnId, sent ?? '', start.messageKey) }, event];
    },
  };
}

export { createStartPairs };
