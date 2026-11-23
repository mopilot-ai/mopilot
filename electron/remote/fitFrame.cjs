// Keeps an event within one sealed frame: a tool's output or a long message that would not fit is shortened (each long string cut, with a note), so the phone gets the event with the start of the text instead of never hearing of it.
const NOTE = '\n… (shortened)';
/** The longest a string may be before the first try, and the point below which it is not cut further (the last cap tried is the first halving above it). */
const START_CHARS = 100_000;
const FLOOR_CHARS = 256;

const sizeOf = (/** @type {unknown} */ value) => Buffer.byteLength(JSON.stringify(value));

/** A copy of `value` with every string longer than `cap` cut to it (never in the middle of a surrogate pair) and noted. @param {any} value @param {number} cap @returns {any} */
function shorten(value, cap) {
  if (typeof value === 'string') {
    if (value.length <= cap) return value;
    const end = /[\ud800-\udbff]/.test(value[cap - 1]) ? cap - 1 : cap;
    return value.slice(0, end) + NOTE;
  }
  if (Array.isArray(value)) return value.map((v) => shorten(v, cap));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v, cap)]));
  return value;
}

/**
 * @template T
 * @param {T} event
 * @param {number} maxBytes what the event may take once encoded
 * @param {number} [floor] the shortest a string may be cut to; cutting stops there and the event is refused (null) when it still does not fit
 * @returns {T | null} the event itself when it fits, a shortened copy when that fits, else null
 */
function fitEvent(event, maxBytes, floor = FLOOR_CHARS) {
  if (sizeOf(event) <= maxBytes) return event;
  for (let cap = START_CHARS; cap > floor; cap = Math.floor(cap / 2)) {
    const shortened = shorten(event, cap);
    if (sizeOf(shortened) <= maxBytes) return shortened;
  }
  return null;
}

module.exports = { fitEvent, shorten, NOTE };
