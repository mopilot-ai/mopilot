// The one pattern for a hidden block (`<tag>\n…\n</tag>`) at the start of a message, shared by what hides the blocks (userText.mjs) and what re-adds one (sideSessions.mjs). A message with nothing after its block, or one a store trimmed or gave CRLF line ends, still matches.

/**
 * Source of a regex matching `<tag>`, a body and `</tag>` with its line end, or the end of the text when nothing follows.
 * @param {string} tag
 */
export function hiddenBlockSource(tag) {
  return `<${tag}>\\r?\\n[\\s\\S]*?\\r?\\n</${tag}>(?:\\r?\\n|$)`;
}
