// How a tool call that a session may not make is refused: a session's hide rule, and the sentence a hidden tool's caller is told. Pure, so every tool channel (sage-mcp's socket, Claude's SDK server, the Host) refuses through it without loading the visibility rules of the app's browser and computer tools (../visibility.cjs).

/**
 * A session's hide rule: `hides(name)` as a strict predicate, carrying `message(name)`, what a call to a
 * tool it hides is told. Every tool channel refuses through hiddenRefusalText, never a fixed sentence.
 * @param {(name: string) => unknown} hides
 * @param {((name: string) => string) | null | undefined} [message]
 * @returns {((name: string) => boolean) & { message?: (name: string) => string }}
 */
function hideRule(hides, message) {
  const rule = (/** @type {string} */ name) => hides(name) === true;
  return typeof message === 'function' ? Object.assign(rule, { message }) : rule;
}

/**
 * What a call to `name` is told when the session's rule `hide` hides it: the rule's own message, or a
 * sentence that names no surface.
 * @param {unknown} hide
 * @param {string} name
 */
function hiddenRefusalText(hide, name) {
  const message = typeof hide === 'function' ? /** @type {any} */ (hide).message : null;
  return typeof message === 'function' ? String(message(name)) : `${name} is unavailable in this session.`;
}

module.exports = { hideRule, hiddenRefusalText };
