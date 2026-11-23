// The turn states a client shows for a chat: one waiting for the user, one running, else idle.

const STATE = Object.freeze(Object.assign(Object.create(null), { running: 'running', awaitingUser: 'waiting' }));

/** A chat's state chip for its SessionState.turn. */
const stateOf = (/** @type {string | undefined} */ turn) => STATE[/** @type {string} */ (turn)] ?? 'idle';

module.exports = { stateOf };
