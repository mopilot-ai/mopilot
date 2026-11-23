// A goal queued on Codex (opts.goal, which only Codex's startGoal reads) going to a harness without native goals: that harness's own /goal command, with the provenance it was queued with (#2249).
const { carryInputGuard } = require('./contract/inputGuard.cjs');

/**
 * An item with a goal set as Codex sets one, going to another harness (the chat switched since it was queued): the
 * /goal command that harness takes, as a switch carries a goal over (continueAfterSwitch), not the objective as a plain
 * message. It keeps its own `human`: a goal round MoPilot sends is not the user's word.
 */
function asGoalCommand(/** @type {any} */ item) {
  if (!item.opts?.goal) return item;
  const { goal, ...opts } = item.opts;
  return carryInputGuard(item, { ...item, text: `/goal ${goal}`, opts });
}

module.exports = { asGoalCommand };
