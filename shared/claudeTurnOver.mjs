// Claude Code's own turn-over signal (#1834), shared by main's controller and the windows' translator. Pure.
//
// With CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS (electron/harness/claude/sessionOptions.cjs) the CLI reports session_state_changed: 'running' or
// 'requires_action' while it works, 'idle' once it has flushed its held-back result and its background loop is done. When Claude Code
// moves a tool call to the background to take a steered message, it folds the steer into the running loop and sends one result for
// both, so counting a result per prompt left the turn running forever, and a Stop sent to the idle CLI got no result either.

/**
 * A session_state_changed `state` during the turn `turn` (the caller's id for its current turn, or null): notes that the CLI ran for
 * it, and on 'idle' says whether that turn is over. An 'idle' counts only after the CLI ran for the same turn, so the previous
 * turn's late 'idle' never ends a new one; a CLI that never sends these events keeps the result count.
 * @param {{ cliRanFor?: unknown }} holder where the turn the CLI last ran for is kept
 * @param {unknown} state
 * @param {unknown} turn
 */
export function claudeTurnOver(holder, state, turn) {
  if (state !== 'idle') {
    holder.cliRanFor = turn;
    return false;
  }
  return turn != null && holder.cliRanFor === turn;
}
