// A chat's items as a delta against what a phone already holds: the phone names the (id, tag) of its last items, the sender answers with the ids in order and only the items that differ, and the phone puts them back together or says it cannot (then it reads the whole chat).
import { sha256Hex } from './sha256.mjs';

/** How many of its last items a phone names; older items are sent whole when they differ, and matched when they do not. */
export const KNOWN_ITEMS = 40;

/** Keys in a fixed order, so the same item always has the same tag whoever built it. @param {unknown} v @returns {unknown} */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(/** @type {any} */ (v)[k]);
    return out;
  }
  return v;
}

/** A short tag of an item's content: equal items have equal tags, and an item that changed (a tool call that finished, a message that grew) has another. @param {{ id: string }} item */
export const itemTag = (item) => sha256Hex(JSON.stringify(canonical(item))).slice(0, 12);

/** The ids and tags of the last `max` items that have an id, oldest first: what a phone sends to say what it holds. @param {{ id?: unknown }[]} items @returns {[string, string][]} */
export function knownOf(items, max = KNOWN_ITEMS) {
  /** @type {[string, string][]} */
  const out = [];
  for (const item of items.slice(-max)) if (typeof item?.id === 'string') out.push([item.id, itemTag(/** @type {any} */ (item))]);
  return out;
}

/**
 * What to send a phone that holds `known`: every id in order, and the items it does not hold as they are (an item with no id is always sent).
 * @param {{ id?: unknown }[]} items the chat's items now
 * @param {[string, string][]} known
 * @returns {{ order: (string | null)[], changed: any[] }} `null` in `order` is an item with no id, taken from `changed` in turn
 */
export function deltaOf(items, known) {
  const held = new Map(known);
  /** @type {(string | null)[]} */
  const order = [];
  /** @type {any[]} */
  const changed = [];
  for (const item of /** @type {any[]} */ (items)) {
    if (typeof item?.id !== 'string') {
      order.push(null);
      changed.push(item);
      continue;
    }
    order.push(item.id);
    if (held.get(item.id) !== itemTag(item)) changed.push(item);
  }
  return { order, changed };
}

/**
 * The items a delta describes, from what the phone holds; `null` when it cannot be put together (an id the phone does not hold and was not sent, a malformed delta), and the phone reads the whole chat instead.
 * @param {any[]} cached the items the phone holds
 * @param {{ order: (string | null)[], changed: any[] }} delta
 */
export function applyDelta(cached, delta) {
  if (!Array.isArray(delta?.order) || !Array.isArray(delta?.changed)) return null;
  const byId = new Map(cached.filter((i) => typeof i?.id === 'string').map((i) => [i.id, i]));
  /** @type {Map<string, any>} */
  const sent = new Map();
  /** @type {any[]} */
  const anonymous = [];
  for (const item of delta.changed) {
    if (typeof item?.id === 'string') sent.set(item.id, item);
    else anonymous.push(item);
  }
  const out = [];
  for (const id of delta.order) {
    if (id === null) {
      if (!anonymous.length) return null;
      out.push(anonymous.shift());
      continue;
    }
    const item = sent.get(id) ?? byId.get(id);
    if (!item) return null;
    out.push(item);
  }
  return anonymous.length ? null : out;
}
