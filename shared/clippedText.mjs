// Text cut short for the model's view, marked where it is cut ("… [+N chars]") so a cut never reads as the page's or app's own
// text, and the one note that says where the rest is. The page agent (pageAgent.cjs q) writes the same mark inline: it is
// serialized into the page and cannot import this.
import { prefixUnits } from './textPrefix.mjs';

/** A cut's mark, as `clip` and the page agent write it. */
const MARK = /… \[\+\d+ chars\]/;

/**
 * `s` when it is at most `n` characters long, else its first n - 1 characters, "…" and how many characters were left out
 * (the mark makes a cut line about 15 characters longer than `n`: not a hard size budget).
 * @param {string} s @param {number} n
 */
export function clip(s, n) {
  if (s.length <= n) return s;
  const kept = prefixUnits(s, n - 1);
  return `${kept}… [+${s.length - kept.length} chars]`;
}

/**
 * The note for a page tree whose lines hold a cut text run, name or value: what the mark means and that get_page_text reads
 * the page's whole text. Empty when nothing was cut. The tool is named without its surface prefix, so the note reads the
 * same in the built-in browser and the user's Chrome on every harness.
 * @param {readonly string[]} lines
 */
export function clippedNote(lines) {
  return lines.some((l) => MARK.test(l)) ? '\n[Text ending "… [+N chars]" is cut there: get_page_text reads the page\'s whole text.]' : '';
}
