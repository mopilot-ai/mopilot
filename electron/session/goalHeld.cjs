// A Claude goal Sage holds (paused, or stopped at the round limit) lives only in a window's state,
// since the CLI has no pause. meta.goalHeld keeps its condition in the chat's file so the goal bar
// still shows it as paused after a restart (WP7-17, A20).
const { clock } = require('../platform/ports/clock.cjs');

/** What to keep for a goal: its condition and how it was held; null when nothing is held. */
function heldOf(goal) {
  if (!goal || (goal.status !== 'paused' && goal.status !== 'budgetLimited')) return null;
  const objective = String(goal.objective ?? '').trim();
  if (!objective) return null;
  return { objective, status: goal.status, limit: goal.claude?.limit ?? null, at: goal.updatedAt ?? null };
}

/** The paused goal the bar shows for a held condition, or null when the record is unusable. */
function restoreGoal(held, chatId, now = clock.now() / 1000) {
  const objective = typeof held?.objective === 'string' ? held.objective.trim() : '';
  if (!objective) return null;
  return {
    threadId: chatId,
    objective,
    status: 'paused',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: held.at ?? now,
    updatedAt: now,
    claude: { iterations: 0, lastReason: null, limit: held.limit ?? null },
  };
}

module.exports = { heldOf, restoreGoal };
