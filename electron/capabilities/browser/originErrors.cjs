// Readable browser-origin policy refusals shared by site permissions and per-action confirmations.
const { ToolError } = require('../contract/registry.cjs');
const { messageOf } = require('../../ignored.cjs');
const codedError = (code, message) => new ToolError(message, code);

/** The tool call was aborted (Stop, a cancel) before the user answered the card for `origin`. */
const abortedBefore = (origin) => codedError('aborted', `The call was stopped before the user answered about ${origin}.`);

/** The card for `origin` went away before anyone answered it (the turn ended): nothing was decided, and the next call asks again. */
const unanswered = (origin) =>
  codedError('unanswered', `The user didn't answer the card about ${origin} before it went away. Ask them in chat, then try again.`);

/**
 * The card for `origin` could not be shown (no window, the broker failed): that is not the user's answer, so
 * nothing is remembered as refused, and the agent is told it can try again.
 */
const unasked = (origin) => (error) => {
  throw codedError('unavailable', `Couldn't ask the user about ${origin}: ${messageOf(error)}. Try again.`);
};

module.exports = { codedError, abortedBefore, unanswered, unasked };
