// A goal's controls on a machine chat (M58): the wire's feature name, the actions the goal bar and a typed /goal have, and the request's shape, so the Mac and the Host read one contract. Setting a goal is a message (`goal: true` on chat.send and chat.start); everything else about a goal is `chat.goal`.

/** The feature both ends declare before a goal is controlled or set; a Host without it is refused by the gate, never sent a request it would drop. */
export const GOAL_FEATURE = 'goalControls';

/** What the goal bar and /goal do to a goal that exists: pause (and stop the running turn), resume, add rounds to a Claude goal at its limit, clear, a Codex token budget, edit a Codex goal's objective. */
export const GOAL_ACTIONS = Object.freeze(['pause', 'resume', 'extend', 'clear', 'budget', 'edit']);

/**
 * The params of `chat.goal`: the chat and the action; `human` (clear: the person typed it), `tokens` (budget: a number of tokens, null to remove it) and `objective` (edit) only where the action takes them.
 * @param {{ effect: (p: any) => object, bad: (message: string) => Error }} kit
 */
export function goalParsers({ effect, bad }) {
  return {
    'chat.goal': (/** @type {any} */ p) => {
      const action = typeof p.action === 'string' && GOAL_ACTIONS.includes(p.action) ? p.action : null;
      if (!action) throw bad('Pick what to do with the goal.');
      const base = effect(p);
      if (action === 'clear') return { ...base, action, ...(p.human === true ? { human: true } : {}) };
      if (action === 'budget') {
        if (p.tokens !== null && !(Number.isSafeInteger(p.tokens) && p.tokens > 0)) throw bad('A budget is a number of tokens, or none.');
        return { ...base, action, tokens: p.tokens };
      }
      if (action === 'edit') {
        const objective = typeof p.objective === 'string' ? p.objective.trim() : '';
        if (!objective || objective.length > 100_000) throw bad('Say what the goal is.');
        return { ...base, action, objective };
      }
      return { ...base, action };
    },
  };
}
