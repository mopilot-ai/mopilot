// Instructions a vendor tool returns alongside a program's output (the Codex Browser plugin sends its whole markdown guide with a
// thread's first cua_repl call): text blocks that are documentation, so prose in them is never read as what the program did.

/** A line that is a markdown heading. */
const HEADING = /^#{1,4} \S/m;

/**
 * Whether one output text block is a vendor's instructions rather than program output: long markdown that starts with
 * a heading and has several more. A program's own printed lines, JSON and errors never look like that.
 * @param {unknown} text
 */
export function isVendorInstructions(text) {
  if (typeof text !== 'string' || text.length < 1000 || !/^\s*#{1,4} \S/.test(text)) return false;
  return text.split(HEADING).length > 3;
}
