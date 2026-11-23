// Codex goals, the part the app and a Host share: the app-server requests each goal action sends (the plans), which goals can resume, and the words of the goal refusals, so a chat on this Mac and a chat on a machine act and speak alike. The goal bar's own wording stays in src/lib/codexGoals.ts.

/** @typedef {import('./model/store').ChatGoal} ThreadGoal */
/** @typedef {{ method: 'thread/goal/set' | 'thread/goal/clear' | 'turn/interrupt', params: Record<string, unknown> }} GoalRequest */

/**
 * Pausing doesn't stop a running turn (the model can still finish the goal in it), so pause and
 * stop both send paused first, then interrupt the turn.
 * @param {string} threadId @param {ThreadGoal | null | undefined} goal @param {string | null | undefined} activeTurnId
 * @returns {GoalRequest[]}
 */
export function goalPausePlan(threadId, goal, activeTurnId) {
  /** @type {GoalRequest[]} */
  const out = [];
  if (goal?.status === 'active') out.push({ method: 'thread/goal/set', params: { threadId, status: 'paused' } });
  if (activeTurnId && !activeTurnId.startsWith('pending-'))
    out.push({ method: 'turn/interrupt', params: { threadId, turnId: activeTurnId } });
  return out;
}

const RESUMABLE = ['paused', 'blocked', 'usageLimited', 'budgetLimited'];
/** Resuming a complete goal would run it again, so only stopped goals can resume. @param {ThreadGoal | null | undefined} goal */
export function canResumeGoal(goal) {
  return !!goal && RESUMABLE.includes(goal.status);
}

/** @param {string} threadId @param {ThreadGoal | null | undefined} goal @returns {GoalRequest[]} */
export function goalResumePlan(threadId, goal) {
  return canResumeGoal(goal) ? [{ method: 'thread/goal/set', params: { threadId, status: 'active' } }] : [];
}

/** Editing changes the objective only: the goal keeps its status, budget and usage. @param {string} threadId @param {ThreadGoal | null | undefined} goal @param {string} objective @returns {GoalRequest[]} */
export function goalEditPlan(threadId, goal, objective) {
  return goal && objective.trim() ? [{ method: 'thread/goal/set', params: { threadId, objective: objective.trim() } }] : [];
}

/** The soft token budget is set on the goal, whatever its status; null removes it. @param {string} threadId @param {ThreadGoal | null | undefined} goal @param {number | null} tokenBudget @returns {GoalRequest[]} */
export function goalBudgetPlan(threadId, goal, tokenBudget) {
  return goal ? [{ method: 'thread/goal/set', params: { threadId, tokenBudget } }] : [];
}

/** @param {string} threadId @param {ThreadGoal | null | undefined} goal @returns {GoalRequest[]} */
export function goalClearPlan(threadId, goal) {
  return goal ? [{ method: 'thread/goal/clear', params: { threadId } }] : [];
}

/** A readable message for a failed goal request, from the app-server's own. @param {string} message */
export function goalErrorWords(message) {
  if (/goals feature is disabled/i.test(message))
    return 'Goals are turned off in Codex settings: set features.goals = true in config.toml (Settings → Codex → Advanced)';
  if (/ephemeral thread/i.test(message)) return "Temporary chats can't have goals";
  return message;
}

/** What a goal action an agent has no form of says (a goal set on another agent before the chat switched): `action` is the first word of the request (`extend`, `budget`, else an edit). @param {string} label @param {string} action */
export function unsupportedGoalWords(label, action) {
  const what = action === 'extend' ? 'add rounds to' : action === 'budget' ? 'budget' : 'edit';
  return `${label} can't ${what} this goal. Clear it and set a new one.`;
}
