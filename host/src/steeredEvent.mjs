// The stream event for a message the agent took into the turn that is running (Claude Code, Codex: the adapters that steer): one typed event for every adapter, so a client shows it in order in that turn and retires the row it kept for it.

/**
 * @param {object} o
 * @param {string} o.chatId the chat's id on this Host
 * @param {string} o.turnId the running turn the message went into
 * @param {string} o.clientId the message's own key (the client's idempotency key)
 * @param {string} [o.text] what was written, when no display input was kept for it
 * @param {any} [o.user] the display input kept for the message (its pictures and files as the client shows them)
 */
export function steeredEvent({ chatId, turnId, clientId, text, user }) {
  return {
    kind: 'steered',
    key: chatId,
    turnId,
    user: user ?? { id: `u-${clientId}`, clientId, messageKey: clientId, content: text ? [{ type: 'text', text }] : [] },
  };
}
