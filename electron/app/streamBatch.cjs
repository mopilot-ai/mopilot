// Sends to windows, a flush's as one stream batch per window: JSON bytes of the text main already has, the rest cloned beside it.
const { knownJson } = require('../harness/eventJson.cjs');
const { countIpc } = require('../perf/probe.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { STREAM_BATCH } = require('../bridge/spec.cjs');

/**
 * An event as one window gets it: with that window's own fields (a Codex event's `mine`), as `{ ...event, ...extra }`.
 * @param {any} event @param {Record<string, unknown> | undefined} extra
 */
const withExtra = (event, extra) => (extra ? { ...event, ...extra } : event);

/** A value's JSON, or null where JSON has none (undefined, a function) or cannot write it (a BigInt, a cycle). */
function jsonOrNull(value) {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : null;
  } catch {
    // the event goes by clone, which takes what JSON cannot write or throws as IPC always did
    return null;
  }
}

/**
 * JSON `json` of an object with `extra`'s fields written after its own, as `{ ...event, ...extra }` writes them unless the
 * object has one of those fields already (then JSON.parse takes the last, the same value). Null for JSON of no object, or
 * for an extra JSON cannot write as the spread has it: that event goes by clone.
 * @param {string} json @param {Record<string, unknown> | undefined} extra
 */
function jsonWithExtra(json, extra) {
  if (!extra) return json;
  if (!json.endsWith('}')) return null;
  const fields = [];
  for (const [key, value] of Object.entries(extra)) {
    const text = jsonOrNull(value);
    if (text === null) return null;
    fields.push(`${JSON.stringify(key)}:${text}`);
  }
  return `${json.slice(0, -1)}${json.length > 2 && fields.length ? ',' : ''}${fields.join(',')}}`;
}

/** UTF-8 of a batch's text in an array of its own: a pooled Buffer is a view of 8 KiB another write shares. */
const encoder = new TextEncoder();

/**
 * The arguments of one `stream:batch` message: the JSON bytes of a list of `[channel, event]`, where an event whose JSON
 * main does not have is `[channel, null, n]`, the n-th of the cloned events that come as the second argument. A batch
 * with no event as JSON is the list itself, cloned, as before.
 * @param {[string, any, Record<string, unknown> | undefined][]} items
 * @returns {[Uint8Array, any[]] | [any[]]}
 */
function streamBatch(items) {
  /** @type {any[]} */
  const cloned = [];
  let asText = 0;
  const parts = items.map(([channel, event, extra]) => {
    const json = knownJson(event);
    const text = json === undefined ? null : jsonWithExtra(json, extra);
    if (text === null) return `[${JSON.stringify(channel)},null,${cloned.push(withExtra(event, extra)) - 1}]`;
    asText++;
    return `[${JSON.stringify(channel)},${text}]`;
  });
  if (!asText) return [items.map(([channel, event, extra]) => [channel, withExtra(event, extra)])];
  return [encoder.encode(`[${parts.join(',')}]`), cloned];
}

/**
 * Sends to windows, each counted by the performance probe (electron/perf/probe.cjs): `send` sends at once, except inside
 * `batch(fn)`, whose sends reach each window as one message when it ends, in order: one event as it always did, several
 * as a stream batch. A batch inside a batch joins it.
 */
function windowSends() {
  /** @type {Map<Electron.WebContents, [string, any, Record<string, unknown> | undefined][]> | null} */
  let collecting = null;
  /** @param {Electron.WebContents} wc @param {[string, any, Record<string, unknown> | undefined][]} items */
  function deliver(wc, items) {
    try {
      if (wc.isDestroyed()) return;
      if (items.length === 1) {
        const [channel, event, extra] = items[0];
        countIpc(channel, wc.id);
        return wc.send(channel, withExtra(event, extra));
      }
      countIpc(STREAM_BATCH, wc.id);
      wc.send(STREAM_BATCH, ...streamBatch(items));
    } catch (error) {
      noteIgnored('send stream events to a window', error);
    }
  }
  return {
    /** @param {() => void} fn */
    batch(fn) {
      if (collecting) return fn();
      const mine = (collecting = new Map());
      try {
        fn();
      } finally {
        collecting = null;
        for (const [wc, items] of mine) deliver(wc, items);
      }
    },
    /**
     * One adapter event to one window; `extra` is that window's own fields.
     * @param {Electron.WebContents} wc @param {string} channel @param {any} event @param {Record<string, unknown>} [extra]
     */
    send(wc, channel, event, extra) {
      if (!collecting) return countIpc(channel, wc.id), wc.send(channel, withExtra(event, extra));
      const items = collecting.get(wc) ?? [];
      collecting.set(wc, items);
      items.push([channel, event, extra]);
    },
  };
}

module.exports = { streamBatch, withExtra, jsonWithExtra, windowSends };
