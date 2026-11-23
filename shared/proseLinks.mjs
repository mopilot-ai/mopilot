// Links written in prose (a reply, a CLI's output): a link ends at whitespace, a quote, a backtick or a closing bracket, and
// sentence punctuation after it is not part of it, so "(https://…/pull/7)." is https://…/pull/7.

/** A link as prose writes it, up to whitespace, a quote, a backtick, `<`/`>` or a closing bracket. */
export const PROSE_LINK = /https?:\/\/[^\s"'`<>)\]]+/g;

/** The link without the sentence punctuation that follows it. @param {string} link */
export const trimLink = (link) => link.replace(/[.,;:!?]+$/, '');

/** Every link in `text`, in order, each trimmed. @param {string} text */
export const proseLinks = (text) => [...String(text).matchAll(PROSE_LINK)].map((m) => trimLink(m[0]));

/**
 * `text` cut around its links: text, link, text, … (always odd in length, a link at each odd index), the punctuation after
 * a link kept in the text that follows it.
 * @param {string} text
 */
export function splitLinks(text) {
  const s = String(text);
  const out = [];
  let last = 0;
  for (const m of s.matchAll(PROSE_LINK)) {
    const link = trimLink(m[0]);
    out.push(s.slice(last, m.index), link);
    last = m.index + link.length;
  }
  out.push(s.slice(last));
  return out;
}
