// What a chat's saved history holds in pictures, found once for all of them (#4820): the messages with attached pictures and the screenshot steps, by item id, from one read of the harness's history instead of one read per picture. Bounded, and read again when the chat's segments change or a picture is asked for that the last read did not have.
const { toolOutput } = require('../../shared/toolOutput.mjs');
const { sliceSegments } = require('../../shared/handoff.mjs');
const { turnIdentity } = require('../../shared/chatNotes.mjs');
const { toRendererSegment } = require('../platform/chats.cjs');

/** The picture blocks of a message's content: Claude's `image` with a data: URL, Codex's and the app's own `localImage` with a file. @param {any} item */
const messagePictures = (item) =>
  (Array.isArray(item?.content) ? item.content : []).filter((/** @type {any} */ c) => c?.type === 'image' || c?.type === 'localImage');
const CALLS = new Set(['mcpToolCall', 'dynamicToolCall']);

/** How much picture an item carries, in characters (0: none, so it is not kept). @param {any} item */
function pictureSize(item) {
  if (item?.type === 'userMessage') {
    const pictures = messagePictures(item);
    return pictures.length ? pictures.reduce((n, p) => n + String(p.url ?? p.path ?? '').length, 1) : 0;
  }
  if (!CALLS.has(item?.type)) return 0;
  const images = toolOutput(item).images;
  return images.length ? images.reduce((n, src) => n + src.length, 1) : 0;
}

/**
 * @typedef {{ native: string, turn: string, item: any }} Held a picture-bearing item, and where it was in the chat's history
 * @typedef {{ signature: string, builtAt: number, bytes: number, ready: Promise<Map<string, Held[]>> }} Entry
 */

/** The segments of a record as the history is read: the same chat again only while these hold. @param {{ segments: any[] }} record */
const signatureOf = (record) => JSON.stringify(record.segments.map((s) => [s.kind, s.nativeId, s.start ?? 0, s.count ?? null]));

/**
 * @param {{ maxEntries?: number, maxBytes?: number, minRefreshMs?: number, now?: () => number }} [o]
 *   maxEntries: chats kept; maxBytes: the picture characters kept in all; minRefreshMs: how soon after a read a missing picture reads again
 */
function createHistoryImageCache({ maxEntries = 4, maxBytes = 64 * 1024 * 1024, minRefreshMs = 5_000, now = Date.now } = {}) {
  /** @type {Map<object, Entry>} least recently used first */
  const entries = new Map();

  /** Reads a record's history and indexes its pictures, newest segment first (as a lookup scans). @param {any} record @param {any} readTurns */
  async function index(record, readTurns) {
    const segments = record.segments.map(toRendererSegment);
    const history = new Map();
    for (const [i, segment] of segments.entries()) {
      if (history.has(segment.nativeId)) continue;
      const page = await readTurns(record.segments[i], undefined, {});
      history.set(segment.nativeId, Array.isArray(page?.turns) ? page.turns : []);
    }
    const slices = sliceSegments(segments, history);
    /** @type {Map<string, Held[]>} */
    const held = new Map();
    let bytes = 0;
    for (let i = slices.length - 1; i >= 0; i--) {
      for (const turn of slices[i]) {
        for (const item of Array.isArray(turn?.items) ? turn.items : []) {
          const size = pictureSize(item);
          if (!size || typeof item.id !== 'string') continue;
          bytes += size;
          const list = held.get(item.id) ?? [];
          list.push({ native: segments[i].nativeId, turn: turnIdentity(turn?.id), item });
          held.set(item.id, list);
        }
      }
    }
    return { held, bytes };
  }

  /** A new entry for a record, put in place at once so that asks arriving together share its read. @param {any} record @param {any} readTurns */
  function begin(record, readTurns) {
    /** @type {Entry} */
    const entry = {
      signature: signatureOf(record),
      builtAt: now(),
      bytes: 0,
      ready: index(record, readTurns).then(({ held, bytes }) => {
        entry.bytes = bytes;
        entry.builtAt = now();
        trim(entry);
        return held;
      }),
    };
    entries.delete(record);
    entries.set(record, entry);
    // a read that failed is not kept: the next ask reads again
    entry.ready.catch(() => {
      if (entries.get(record) === entry) entries.delete(record);
    });
    return entry;
  }

  /** Drops the least recently used chats beyond the limits; a chat too large to keep alone is not kept. @param {Entry} latest */
  function trim(latest) {
    let total = 0;
    for (const e of entries.values()) total += e.bytes;
    for (const [record, e] of entries) {
      if (entries.size <= maxEntries && total <= maxBytes) break;
      if (e === latest && entries.size > 1) continue;
      total -= e.bytes;
      entries.delete(record);
    }
  }

  /** The held item an ask names, newest segment first; a scope `[segment, turn]` limits where. @param {Map<string, Held[]>} held @param {string} id @param {any} scope @param {(item: any) => boolean} accepts */
  function pick(held, id, scope, accepts) {
    for (const h of held.get(id) ?? []) {
      if (scope?.[0] != null && scope[0] !== h.native) continue;
      if (scope?.[1] != null && scope[1] !== h.turn) continue;
      if (accepts(h.item)) return h.item;
    }
    return null;
  }

  return {
    /**
     * The picture-bearing item `id` names (scoped as a structured reference is), or null. The chat's history is read once and kept; an item
     * it does not hold is looked for again by reading afresh, at most once in `minRefreshMs`, however many asks come together.
     * @param {any} record @param {any} readTurns @param {string} id @param {any} scope @param {(item: any) => boolean} accepts @param {() => void} check
     */
    async find(record, readTurns, id, scope, accepts, check) {
      check();
      let entry = entries.get(record);
      if (!entry || entry.signature !== signatureOf(record)) entry = begin(record, readTurns);
      else {
        // used last: it goes last
        entries.delete(record);
        entries.set(record, entry);
      }
      let held = await entry.ready;
      check();
      const found = pick(held, id, scope, accepts);
      if (found || now() - entry.builtAt < minRefreshMs) return found;
      // not there, and the read is not new: it may have been written since; those asking together read it once
      const current = entries.get(record);
      const fresh = current && current !== entry ? current : begin(record, readTurns);
      held = await fresh.ready;
      check();
      return pick(held, id, scope, accepts);
    },
  };
}

module.exports = { createHistoryImageCache };
