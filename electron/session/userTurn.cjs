// Whether a chat's current turn carries the user's word (#2249): the user started it and nothing but their own input has entered it since. The gates that act on the user's word (start_session, hand-offs, offers) read isUserTurn; whether someone is there to answer a card (attendance) reads `human` / `userEngaged` as before. ChatController.dispatch marks a turn with withInput as input reaches it.

/** Whether `turn` (SessionState.activeTurn) is the user's: started by them, with no input since that no human wrote. */
const isUserTurn = (/** @type {any} */ turn) => !!turn && turn.human === true && turn.nonHuman !== true;

/** Attendance, distinct from authority: the user started or steered this turn, even if automatic input also entered it. */
const turnHasPerson = (/** @type {any} */ turn) => !!(turn?.human || turn?.userEngaged);

/**
 * The turn once `item` entered it: input no human wrote (a peer message, MoPilot's own text) makes it no longer the
 * user's, for the rest of the turn; the user's own input leaves it as it is. A handoff prefix is MoPilot's own text.
 * @param {any} turn @param {any} item
 */
const withInput = (turn, item) =>
  !turn || turn.nonHuman === true || (item?.opts?.human === true && !item.opts.prefix && !item.peer) ? turn : { ...turn, nonHuman: true };

/**
 * What a turn's completion says of the turn that ended (ChatController.end, read before it clears activeTurn): its id,
 * and whether a person took part (started it, or wrote into it), so a linked session's turn then wakes no parent
 * (orchestration/reportRoute.cjs, Claude Desktop's turnInput.person).
 * @param {any} turn
 */
const endedTurn = (turn) => ({ turnId: turn?.id ?? null, person: turnHasPerson(turn) });

module.exports = { isUserTurn, turnHasPerson, withInput, endedTurn };
