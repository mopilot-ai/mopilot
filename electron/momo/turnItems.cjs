// How MoMo's background readers (the history index, the memory pass) read a chat's turn items from the shared peer transcript, the same on every harness: a user message's words are its content's text parts, as Codex's rollout reader, Claude Code's transcript translator and ACP's record replay all make them; never a field assumed to hold them.

/**
 * The words of a user message item: its content's text parts joined by lines ('' when it has none).
 * @param {unknown} it
 */
function userMessageText(it) {
  const content = /** @type {any} */ (it)?.content;
  return (Array.isArray(content) ? content : [])
    .filter((/** @type {any} */ c) => c?.type === 'text' && typeof c.text === 'string')
    .map((/** @type {any} */ c) => c.text)
    .join('\n');
}

module.exports = { userMessageText };
