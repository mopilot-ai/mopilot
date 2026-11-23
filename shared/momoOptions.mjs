// MoMo's answer chips (the design's one-tap options under a plain question, alignment row 6): a reply may end with one line `Options: A | B | C`, the same text on every harness; clients draw the line as outlined chips under the reply and never as text, and a tap sends the label as the person's own message.

/** The fewest and the most chips one question carries, and the longest label. */
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_LABEL = 40;

/** What the model is told about the line (carried in MoMo's context block, shared/momoContext.mjs). */
export const OPTIONS_NOTE =
  'When you ask the user a question with a few short answers, end the reply with one last line `Options: A | B | C` (two to four answers, each at most 40 characters): the user sees them as buttons and a tap sends that answer. Leave the line out for an open question.';

const LINE = /^Options:[ \t]*(\S.*)$/;

/**
 * A reply split into what is shown and its chips: the last line `Options: A | B | C` leaves the text and gives its labels (trimmed, in order). A line that is not a valid one (fewer or more labels than allowed, an empty or too long label, a repeat), or a reply that is only that line, is left in the text as written: no chip is made from guesswork and no words are hidden.
 * @param {unknown} reply
 * @returns {{ text: string, options: string[] }}
 */
export function readOptions(reply) {
  const text = typeof reply === 'string' ? reply : '';
  const lines = text.trimEnd().split('\n');
  const m = LINE.exec(lines[lines.length - 1].trim());
  const body = lines.slice(0, -1).join('\n').trimEnd();
  if (!m || !body.trim()) return { text, options: [] };
  const labels = m[1].split('|').map((s) => s.trim());
  const distinct = new Set(labels.map((s) => s.toLowerCase())).size === labels.length;
  const valid = labels.length >= MIN_OPTIONS && labels.length <= MAX_OPTIONS && labels.every((s) => s && s.length <= MAX_LABEL) && distinct;
  return valid ? { text: body, options: labels } : { text, options: [] };
}

/**
 * A MoMo reply (a thread item or a phone row: anything with `text`) as every client shows it: its `Options:` line out of the text and its labels in `options`. The same object when it has no valid line, so `options` is never present and empty.
 * @template {{ text?: unknown }} T
 * @param {T} item
 * @returns {T | (Omit<T, 'text'> & { text: string, options: string[] })}
 */
export function withOptions(item) {
  const read = readOptions(item.text);
  return read.options.length ? { ...item, text: read.text, options: read.options } : item;
}
