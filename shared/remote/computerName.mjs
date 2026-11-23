// The name a phone shows for a paired computer: the host name the Mac reports in machine.hello, made safe to store and draw.
const MAX_NAME = 64;
const code = (/** @type {number[]} */ ...points) => String.fromCodePoint(...points);
// Characters that draw nothing or reorder what is around them: C0 and C1 controls, the Unicode line and paragraph separators, zero-width
// and direction marks, bidirectional embeddings, overrides and isolates, and the byte order mark. Built from code points so the source holds none.
const HIDDEN = new RegExp(
  `[${code(0)}-${code(31)}${code(127)}-${code(159)}${code(0x2028)}-${code(0x2029)}${code(0x200b)}-${code(0x200f)}${code(0x202a)}-${code(0x202e)}${code(0x2066)}-${code(0x2069)}${code(0x061c, 0xfeff)}]`,
  'g',
);

/**
 * @param {unknown} value what a computer reported, which may be anything
 * @returns {string | null} a short single-line name, or null when there is nothing usable (the phone then keeps its own wording)
 */
export function cleanComputerName(value) {
  if (typeof value !== 'string') return null;
  const name = [
    ...value
      .replace(HIDDEN, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\.local$/i, ''),
  ]
    .slice(0, MAX_NAME)
    .join('')
    .trim();
  return name || null;
}
