// The note under a page read that shows "Page 1 of 2": the list goes on elsewhere, so the model must open the other pages before it
// counts or totals (#3571: a weekly report took the refunds of page 1 of the order list, and the one on page 2 was never read).
// Shared by read_page, get_page_text, the page tree or diff after an action and browser_script's result, on every harness and for the
// built-in browser and Chrome alike.

/**
 * "Page 3 of 12": a position in a paged list (English; a text that spells the position another way is not matched). Also straight
 * after a JSON-escaped newline, tab or return: a script result's text has "\\nPage 1 of 2", where no word boundary lies between the n and the P.
 */
const PAGE_OF = /(?:\b|(?<=\\[ntr]))page\s+(\d{1,4})\s+of\s+(\d{1,4})\b/gi;

/**
 * Every "Page X of Y" position a text shows, in order (X and Y whole numbers, 1 <= X <= Y).
 * @param {string} text
 * @returns {{ here: number, of: number }[]}
 */
export function pagePositions(text) {
  return [...String(text).matchAll(PAGE_OF)]
    .map((m) => ({ here: Number(m[1]), of: Number(m[2]) }))
    .filter((p) => p.here >= 1 && p.here <= p.of);
}

/**
 * The note for a result that shows page X of Y with X < Y, else ''. Only the first such position counts. A result that also shows
 * the other pages is still told: the text does not say whether those pages belong to this list (a filtered list's page 2 is not the
 * unfiltered list's page 2, and a pager's dropdown names every page), so a missed page costs more than one more line.
 * @param {readonly string[]} lines the text of the result, as lines or as one string in a list
 */
export function pagingNote(lines) {
  for (const line of lines) {
    // a result without text (a page that gave none) has no position to name
    if (typeof line !== 'string') continue;
    for (const { here, of } of pagePositions(line)) if (here < of) return noteFor(here, of);
  }
  return '';
}

/** The note's text for page `here` of `of` (also how a replay finds it again in a stored result). */
export const noteFor = (/** @type {number} */ here, /** @type {number} */ of) =>
  `\n[This is page ${here} of ${of} of a list: the rest is on the other page${of - here > 1 ? 's' : ''}. Open ${of - here > 1 ? 'them' : 'it'} before counting or totalling.]`;

/**
 * `text` with the note under it when it shows page X of Y of a list it does not show whole.
 * @param {string} text
 */
export const withPagingNote = (text) => `${text}${pagingNote([text])}`;
