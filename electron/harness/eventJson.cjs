// The JSON text main already has of a stream event (the stream batcher's delta, the core's join of several), so a window's
// stream batch carries it as it is, with no stringify of its own (electron/app/windows.cjs).

/** @type {WeakMap<object, string>} */
const known = new WeakMap();

/**
 * Keep `json` as the text of `event`, which nothing changes after it was emitted: an adapter's event is new each time.
 * @template T @param {T} event @param {string} json @returns {T}
 */
function remember(event, json) {
  if (event !== null && typeof event === 'object') known.set(event, json);
  return event;
}

/** The text kept for `event`, or undefined. @param {unknown} event */
function knownJson(event) {
  return event !== null && typeof event === 'object' ? known.get(event) : undefined;
}

module.exports = { remember, knownJson };
