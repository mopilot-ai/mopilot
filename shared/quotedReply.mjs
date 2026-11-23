// A message that starts with quotes ("> " lines, each quote ended by a blank line) split into the quotes and the words under them, so the phone and the Mac draw a phone's Reply (#4837) as a quote and not as raw ">" text.

const isQuoteLine = (line) => /^>( |$)/.test(line);

/**
 * The quotes a message starts with, each as its raw "> " lines, and the rest: consecutive quote blocks (separated by blank lines) ended by
 * a blank line or the end of the message. Null when it does not start with a quote, when a quote runs straight into other text, or when the
 * quotes say nothing.
 * @param {string} text
 * @returns {{ blocks: string[], rest: string } | null}
 */
export function quoteBlocks(text) {
  const lines = String(text).split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length && isQuoteLine(lines[i])) {
    const start = i;
    while (i < lines.length && isQuoteLine(lines[i])) i += 1;
    if (i < lines.length && lines[i].trim() !== '') return null;
    blocks.push(lines.slice(start, i).join('\n'));
    while (i < lines.length && lines[i].trim() === '') i += 1; // the blank lines under a quote; another quote may follow them
  }
  if (!blocks.length || blocks.every((b) => !unquote(b).trim())) return null;
  return { blocks, rest: lines.slice(i).join('\n').replace(/^\n+/, '') };
}

const unquote = (block) =>
  block
    .split('\n')
    .map((line) => line.slice(2))
    .join('\n');

/**
 * The quote a message starts with and the rest, or null when it does not start with one. Several quotes are one quote, a blank line between
 * them (a line that begins with ">" and runs straight into other text is not a quote).
 * @param {string} text
 * @returns {{ quote: string, rest: string } | null}
 */
export function splitQuote(text) {
  const found = quoteBlocks(text);
  return found && { quote: found.blocks.map(unquote).join('\n\n'), rest: found.rest };
}
