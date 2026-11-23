// A chat's goal status as main knows it, on every harness and with no window open: the adapter's own record where one keeps it (Codex), else the session state's goal (Claude's, which main writes).

/**
 * Codex's session-state goal is a window's report (a window writes it back after main's goal event), so it lags and is
 * missing with no window open; a gate that reads only it lets a running goal through (#2759).
 * @param {string | null | undefined} own the adapter's record: a status, null once it saw the goal cleared, undefined without one
 * @param {{ status?: string } | null | undefined} goal the session state's goal
 * @returns {string | null} null: the chat has no goal
 */
function chatGoalStatus(own, goal) {
  if (own !== undefined) return own;
  // a goal with no status read counts as running, so no gate lets it through
  return goal ? (goal.status ?? 'active') : null;
}

/** Whether a goal with this status holds its chat (running, paused or limited); a complete one, or none, does not. */
const goalHolds = (/** @type {string | null} */ status) => status !== null && status !== 'complete';

module.exports = { chatGoalStatus, goalHolds };
