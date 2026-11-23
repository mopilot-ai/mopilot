// A Codex chat's goal controls on the Host (`chat.goal`): the same app-server requests the app sends for a chat on this Mac (the plans of shared/codexGoals.mjs), run through the Host's own Codex adapter. The goal the chat shows comes back on the state lane, as the adapter's notifications and these answers write it into the store.
import { HostRefusal } from './hostFs.mjs';
import {
  goalBudgetPlan,
  goalClearPlan,
  goalEditPlan,
  goalErrorWords,
  goalResumePlan,
  unsupportedGoalWords,
} from '../../shared/codexGoals.mjs';

/** What a client is told when the thread is open in a Codex app of the machine's own: only one holds it. */
const LOCKED = 'This chat is open in another Codex app on this machine. Close it there to change it.';

/** @param {string} code @param {string} words */
const refuse = (code, words) => new HostRefusal(code, words);

/**
 * @param {object} o
 * @param {{ request: (method: string, params: object) => Promise<any>, leased: (chatId: string, method: string, params?: object) => Promise<{ locked?: boolean, result?: any }>, codexThread: (chatId: string) => string | null, stopTurn: (chatId: string) => Promise<unknown> }} o.adapter the Host's CodexAdapter
 * @param {{ get: (chatId: string) => { goal?: any }, patch: (chatId: string, p: object) => unknown }} o.state the SessionStore
 */
export function createCodexGoals({ adapter, state }) {
  /** The chat's goal: the store's, else what the app-server has for the thread (a chat nobody has opened since the Host started). @param {string} chatId @param {string} thread */
  const goalOf = async (chatId, thread) =>
    state.get(chatId).goal ?? (await adapter.request('thread/goal/get', { threadId: thread }).catch(() => null))?.goal ?? null;

  /**
   * What the goal bar does to the chat's goal. The goal now is the answer.
   * @param {{ chatId: string, action: string, human?: boolean, tokens?: number | null, objective?: string }} p
   */
  return async function goal({ chatId, action, tokens = null, objective = '' }) {
    if (action === 'extend') throw refuse('unsupported', unsupportedGoalWords('Codex', action));
    // as Stop does: the goal is paused first (it would carry on in this turn and the next), then the running turn is interrupted
    if (action === 'pause') {
      await adapter.stopTurn(chatId);
      return state.get(chatId).goal ?? null;
    }
    const thread = adapter.codexThread(chatId);
    if (!thread) throw refuse('unsupported', "This chat isn't running on Codex.");
    const now = await goalOf(chatId, thread);
    const plan =
      action === 'resume'
        ? goalResumePlan(thread, now)
        : action === 'edit'
          ? goalEditPlan(thread, now, objective)
          : action === 'budget'
            ? goalBudgetPlan(thread, now, tokens)
            : goalClearPlan(thread, now);
    if (!plan.length) throw refuse('unsupported', now && action === 'resume' ? "This goal can't be resumed." : 'No goal set');
    for (const { method, params } of plan) {
      /** @type {{ locked?: boolean, result?: any }} */
      let made;
      try {
        made = await adapter.leased(chatId, method, params);
      } catch (error) {
        throw refuse('unsupported', goalErrorWords(error instanceof Error ? error.message : String(error)));
      }
      if (made.locked) throw refuse('unsupported', LOCKED);
      if (method === 'thread/goal/clear') state.patch(chatId, { goal: null });
      else if (made.result?.goal) state.patch(chatId, { goal: made.result.goal });
    }
    return state.get(chatId).goal ?? null;
  };
}
