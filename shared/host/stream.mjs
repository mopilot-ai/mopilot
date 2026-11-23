// The frames of a Host session stream (docs: design/host/index.html, package 2.3): the Hello that opens it and the Durable, Delta and Retract frames that follow, with one parser the client uses on what a Host sends.

/** Frames one subscription may hold unsent before its stream is closed with `overflow`. */
export const MAX_QUEUE = 1024;
/** Deltas of one in-flight key a Hello carries; a longer run is cut from the front and flagged `truncated`. */
export const MAX_INFLIGHT_DELTAS = 512;

const isCount = (/** @type {unknown} */ n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;
const isKey = (/** @type {unknown} */ k) => typeof k === 'string' && k.length > 0 && k.length <= 300;
const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A frame this app cannot read: the stream is dropped and resubscribed, the frame is never applied. */
export class StreamFrameError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'StreamFrameError';
    this.code = 'bad_stream_frame';
  }
}
const bad = (/** @type {string} */ m) => new StreamFrameError(m);

/**
 * A frame from a Host, checked and normalized. `seq` is one counter for the durable and ephemeral lanes together.
 * @param {unknown} f
 */
export function parseFrame(f) {
  if (!isObject(f)) throw bad('A stream frame is not an object.');
  const o = /** @type {Record<string, any>} */ (f);
  if (!isCount(o.seq)) throw bad('A stream frame has no sequence number.');
  switch (o.t) {
    case 'hello': {
      if (!isCount(o.rev) || !isCount(o.epoch)) throw bad('A hello has no revision or epoch.');
      if (o.snapshot != null && !isObject(o.snapshot)) throw bad('A hello has a bad snapshot.');
      // an older Host may omit the in-flight list
      const inflight = o.inFlightEphemeral ?? [];
      if (!Array.isArray(inflight) || !inflight.every((e) => isObject(e) && isKey(e.key) && Array.isArray(e.deltas)))
        throw bad('A hello has a bad in-flight list.');
      return {
        t: 'hello',
        seq: o.seq,
        rev: o.rev,
        epoch: o.epoch,
        // an older Host names none
        generation: typeof o.generation === 'string' ? o.generation : '',
        snapshot: o.snapshot ?? null,
        // the chat's state now (title, goal, tasks: ./stream2.mjs); an older Host names none
        ...(isObject(o.chatState) ? { chatState: o.chatState } : {}),
        inFlightEphemeral: inflight.map((e) => ({ key: e.key, deltas: e.deltas, truncated: e.truncated === true })),
      };
    }
    case 'durable': {
      if (!isCount(o.rev) || !isObject(o.item)) throw bad('A durable frame has no revision or item.');
      if (o.promotes !== undefined && !isKey(o.promotes)) throw bad('A durable frame promotes a bad key.');
      return { t: 'durable', seq: o.seq, rev: o.rev, item: o.item, ...(o.promotes === undefined ? {} : { promotes: o.promotes }) };
    }
    case 'delta':
      if (!isKey(o.key) || o.delta === undefined) throw bad('A delta has no key or content.');
      return { t: 'delta', seq: o.seq, key: o.key, delta: o.delta };
    case 'state':
      if (!isObject(o.patch)) throw bad('A state frame has no patch.');
      return { t: 'state', seq: o.seq, patch: o.patch };
    case 'retract':
      if (!isKey(o.key)) throw bad('A retract names no key.');
      return { t: 'retract', seq: o.seq, key: o.key };
    default:
      throw bad('A stream frame has an unknown kind.');
  }
}
