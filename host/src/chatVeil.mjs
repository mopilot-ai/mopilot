// The one place chats a client may not see leave and enter the protocol (M1 H2a, designs/momo-m1-home): a feature that keeps chats apart (MoMo) gives rules; for each connection this wraps what comes in (a request that names such a chat), what goes out (results and pushed events that name one) and says nothing else. A caller that may not see them gets what a chat the Host never heard of gives: a request for a hidden chat runs on a fresh chat of the same shape and everything it says is told back under the id it asked about; a result or event that names a hidden chat is left out. A granted caller is held to the feature's own rules, per message, so a grant that ends ends what it hears.
import crypto from 'node:crypto';

/**
 * @typedef {object} ChatRules
 * @property {() => boolean} any whether there is any chat to keep apart (the check that costs nothing on a Host with none)
 * @property {(chatId: string) => 'open' | 'hidden'} state whether a chat is one of those kept apart
 * @property {(principal: unknown) => boolean} seen whether this caller may see the hidden chats
 * @property {(chatId: string) => boolean} forged whether an id has the form only the Host makes for these chats, and no such chat has it: a client made it
 * @property {() => Error} invalid what a request is told for an id that cannot be used
 * @property {(chatId: string) => boolean} isDecoy whether a chat was made for a caller that may not see the hidden ones: shown to that connection only
 * @property {(chatId: string, on: boolean) => void} decoy tells the rules of a chat made for a caller that may not see the hidden ones (shown to no one else), or let go of
 * @property {(fn: (e: { running: boolean, state: string }) => void) => () => void} [watch] tells when the feature's home starts or stops running here; returns the way to stop
 * @property {(chatId: string) => void} [sendFailed] a send that was accepted into the chat's ledger threw before the chat took it: the turn ended without a `turnEnd`, so the rule settles it as failed
 * @property {(method: string, params: any, principal?: any) => any} guard what a caller that may see them may do to one: throws a refusal, or returns the parameters (a folder or a pick put right)
 */

/**
 * What a rule's `guard` returns when the request is answered without running: the value is the reply, and the request never reaches
 * the runtime (a message the home already has: a resend is the same turn, never a second run).
 */
export class Answered {
  /** @param {unknown} value */
  constructor(value) {
    this.value = value;
  }
}

/** What a client may ask for with an id of a chat that does not exist yet: it makes the chat. */
const CREATING = new Set(['chat.start', 'chat.send']);
/** How many hidden chats one connection may ask about: each gets a chat of its own, which goes when the connection does. */
export const MAX_DECOYS = 8;

/** Chat ids as the Host makes them end in a uuid, or in anything after the last colon. @param {string} id @param {() => string} newId */
const freshLike = (id, newId) => `${id.slice(0, id.lastIndexOf(':') + 1)}${newId()}`;

/** @param {unknown} v @param {(s: string) => string} map */
export function mapStrings(v, map) {
  if (typeof v === 'string') return map(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, map));
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(/** @type {Record<string, unknown>} */ (v)).map(([k, x]) => [map(k), mapStrings(x, map)]));
  return v;
}

/**
 * @param {ChatRules} rules
 * @param {{ newId?: () => string, report?: (message: string) => void }} [o]
 */
export function createChatVeil(rules, { newId = () => crypto.randomUUID(), report = (/** @type {string} */ _m) => undefined } = {}) {
  /**
   * One connection. `emit` is what it sends to its client; `wrap` puts the veil round the connection the protocol made.
   * @param {(message: object) => void} emit @param {{ principal?: () => unknown }} who
   */
  return (emit, who) => {
    /** The chats this caller asked about that are hidden from it, and the fresh ones that stood in for them. @type {Map<string, string>} */
    const sinks = new Map();
    /** @type {Map<string, string>} */
    const asked = new Map();
    let hello = false;
    const seen = () => rules.seen(who.principal?.());
    // a Host that stops being the home mid-connection says so: the `momoHome` feature the hello offered is withdrawn (or offered again)
    const stopWatching = rules.watch?.((e) => {
      if (seen()) emit({ event: 'momoHome', momoHome: e.running, state: e.state });
    });
    /** The epoch the caller used with each chat made for it, to let it go. @type {Map<string, number>} */
    const epochs = new Map();
    const hidden = (/** @type {unknown} */ id) => typeof id === 'string' && !asked.has(id) && rules.state(id) === 'hidden';
    /** A chat made for another connection: no one else is told of it, whatever they may see. */
    const decoyOf = (/** @type {unknown} */ id) => typeof id === 'string' && !asked.has(id) && rules.isDecoy(id);
    const sinkOf = (/** @type {string} */ id) => {
      let s = sinks.get(id);
      if (!s) {
        if (sinks.size >= MAX_DECOYS) throw rules.invalid();
        s = freshLike(id, newId);
        sinks.set(id, s);
        asked.set(s, id);
        rules.decoy(s, true);
      }
      return s;
    };
    const told = (/** @type {unknown} */ v) => (asked.size ? mapStrings(v, (s) => asked.get(s) ?? s) : v);
    /** Whether an object names a hidden chat as the one it is about. @param {any} x */
    const about = (/** @type {any} */ x, /** @type {(id: unknown) => boolean} */ isOut) => isOut(x.chatId) || isOut(x.chat);
    /**
     * A result with what names a chat that `isOut` says is hidden left out; the very same value when nothing was (a history or a
     * diff is walked, never copied).
     * @param {unknown} v @param {(id: unknown) => boolean} isOut @returns {unknown}
     */
    const scrub = (v, isOut) => {
      if (Array.isArray(v)) {
        let changed = false;
        /** @type {unknown[]} */
        const kept = [];
        for (const x of v) {
          if (x && typeof x === 'object' && about(x, isOut)) {
            changed = true;
            continue;
          }
          const y = scrub(x, isOut);
          changed ||= y !== x;
          kept.push(y);
        }
        return changed ? kept : v;
      }
      if (v && typeof v === 'object') {
        let changed = false;
        /** @type {Record<string, unknown>} */
        const kept = {};
        for (const [k, x] of Object.entries(v)) {
          if (k.includes(':') && isOut(k)) {
            changed = true;
            continue;
          }
          const y = scrub(x, isOut);
          changed ||= y !== x;
          kept[k] = y;
        }
        return changed ? kept : v;
      }
      return v;
    };
    /** The chat ids an event names: its own, and those of what it carries (a frame, a tool or browser payload, a card, an audit-like record). @param {any} m */
    const named = (m) => [m?.chatId, m?.payload?.chatId, m?.frame?.chatId, m?.card?.chatId, m?.what?.chatId, m?.event?.chatId];
    return {
      emit: (/** @type {any} */ message) => {
        // MoMo's chats are not told to a caller that may not see them, and a chat made for another connection to no one else
        if (named(message).some(decoyOf) || (!seen() && named(message).some(hidden))) return;
        emit(told(message));
      },
      /** @template {{ call: (method: string, raw: unknown) => Promise<any>, close: () => void }} C @param {C} conn @returns {C} */
      wrap: (conn) => ({
        ...conn,
        async call(method, raw) {
          const p = /** @type {any} */ (raw);
          let params = raw;
          if (method === 'host.hello' && Array.isArray(p?.moved)) {
            // a chat moved to another Host is not one of these: they stay where they are
            params = { ...p, moved: p.moved.filter((/** @type {any} */ m) => !hidden(m?.chatId)) };
          } else if (hello && typeof p?.chatId === 'string') {
            // only the Host makes the ids of the chats it keeps apart: a client's is refused like any id that cannot be used
            if (CREATING.has(method) && rules.forged(p.chatId)) throw rules.invalid();
            if (rules.any() && rules.state(p.chatId) === 'hidden') {
              params = seen() ? await rules.guard(method, p, who.principal?.()) : { ...p, chatId: sinkOf(p.chatId) };
              if (!seen() && Number.isSafeInteger(p.epoch)) epochs.set(sinkOf(p.chatId), p.epoch);
            }
          }
          if (params instanceof Answered) return params.value;
          let result;
          try {
            result = await conn.call(method, params);
          } catch (error) {
            // the send was accepted into the ledger but never ran: no turn end will come, so the turn ends here (a resend under the same id is `failed`, never open for ever)
            if (method === 'chat.send' && params !== raw && seen()) rules.sendFailed?.(String(p.chatId));
            throw error;
          }
          if (method === 'host.hello') hello = true;
          return told(rules.any() ? scrub(result, seen() ? decoyOf : (id) => hidden(id) || decoyOf(id)) : result);
        },
        /** The connection ends: the chats made for it go with it, and nothing of them stays in the Host's journal. */
        close() {
          stopWatching?.();
          for (const sink of sinks.values()) {
            rules.decoy(sink, false);
            conn
              .call('chat.remove', { chatId: sink, epoch: epochs.get(sink) ?? 0, key: `key-${crypto.randomBytes(4).toString('hex')}` })
              .catch((/** @type {Error} */ error) => report(`A chat made for a caller could not be removed: ${error.message}`));
          }
          conn.close();
        },
      }),
    };
  };
}
