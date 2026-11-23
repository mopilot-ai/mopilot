// How a Codex chat runs a semantic (src/store/session/runSemantic.ts): the app-server calls behind goals,
// rename, shell commands and fork. The window's store keeps what it shows; the harness's
// own steps are here.
import { ownTable } from '../../../../shared/ownTable.mjs';
import {
  goalBudgetPlan,
  goalClearPlan,
  goalEditPlan,
  goalErrorMessage,
  goalPausePlan,
  goalResumePlan,
  parseTokenBudget,
} from '../../../lib/codexGoals';
import { native } from '../../../lib/native';
import { errorText, ignoring } from '../../../lib/ignored';
import { sessionOf } from '../../../store/session/useSession';
import { copyChatConfig } from '../../../store/projects';
import { get as getState, toast, upsertThread } from '../../../store/core';
import { inheritCodexPin } from '../../../store/accounts';
import { loadGoal, revertThread, setGoalState } from '../../../store/actions';
import { nativeOf } from '../../../store/chats';
import { navigate } from '../../../store/panes';
import { withLease } from '../../../store/threads';
import type { ChatGoal } from '../../../store/types';
import type { Semantic } from '../../../harness/adapter';
import { codexRequest } from '../../../harness/adapters/codex';
import { codexApi } from '../../../harness/adapters/codexApi';
import { unsupportedGoal, type SemanticHandler } from '../../../harness/adapters/semantics';

/** What thread/goal/set and its kin answer, as far as it is read here. */
type GoalResponse = { goal?: ChatGoal | null };

/**
 * Pause the goal and stop the running turn (or `turnId`, the turn a button showed: turn/interrupt names it): a paused
 * goal can still be finished by the turn already running.
 */
export async function pauseCodexGoal(chatId: string, turnId = getState().runtime[chatId]?.activeTurnId) {
  const nid = nativeOf(chatId);
  for (const { method, params } of goalPausePlan(nid, sessionOf(chatId).goal, turnId)) {
    if (method === 'thread/goal/set') {
      // a hung call must not hold up the interrupt
      const r = (await Promise.race([
        withLease(chatId, method, params).catch((e) => toast(`Couldn't pause goal: ${goalErrorMessage(e)}`, 'error')),
        new Promise((res) => setTimeout(res, 500)),
      ])) as GoalResponse | undefined;
      // not awaited: recording the paused goal must not hold up the interrupt below either
      if (r?.goal) setGoalState(chatId, r.goal).catch(ignoring("record a Codex chat's paused goal"));
    } else {
      await codexRequest(method, params).catch((e: Error | null | undefined) => toast(`Couldn't stop: ${errorText(e)}`, 'error'));
    }
  }
}

async function resumeGoal(chatId: string) {
  for (const { method, params } of goalResumePlan(nativeOf(chatId), sessionOf(chatId).goal)) {
    try {
      const r = await withLease<GoalResponse>(chatId, method, params);
      if (r?.goal) await setGoalState(chatId, r.goal);
    } catch (e) {
      toast(`Couldn't resume goal: ${goalErrorMessage(e)}`, 'error');
    }
  }
}

/** args after "budget": "200k", or "none" to remove it */
async function setGoalBudget(chatId: string, args: string) {
  const tokens = parseTokenBudget(args);
  if (tokens === undefined) return toast('Budget: a number of tokens like 200k, or none', 'error');
  if (!sessionOf(chatId).goal) await loadGoal(chatId);
  const plan = goalBudgetPlan(nativeOf(chatId), sessionOf(chatId).goal, tokens);
  if (!plan.length) return toast('No goal set');
  for (const { method, params } of plan) {
    try {
      const r = await withLease<GoalResponse>(chatId, method, params);
      if (r?.goal) await setGoalState(chatId, r.goal);
    } catch (e) {
      toast(`Couldn't set the budget: ${goalErrorMessage(e)}`, 'error');
    }
  }
}

/** args after "edit": the new objective */
async function editGoal(chatId: string, objective: string) {
  if (!sessionOf(chatId).goal) await loadGoal(chatId);
  const plan = goalEditPlan(nativeOf(chatId), sessionOf(chatId).goal, objective);
  if (!plan.length) {
    toast('No goal set');
    return false;
  }
  for (const { method, params } of plan) {
    try {
      const r = await withLease<GoalResponse>(chatId, method, params);
      if (r?.goal) await setGoalState(chatId, r.goal);
    } catch (e) {
      toast(`Couldn't edit goal: ${goalErrorMessage(e)}`, 'error');
      return false;
    }
  }
  return true;
}

async function clearGoal(chatId: string) {
  if (!sessionOf(chatId).goal) await loadGoal(chatId);
  const plan = goalClearPlan(nativeOf(chatId), sessionOf(chatId).goal);
  if (!plan.length) return toast('No goal set');
  for (const { method, params } of plan) {
    try {
      const r = await withLease(chatId, method, params);
      if (r) await setGoalState(chatId, null);
    } catch (e) {
      toast(`Couldn't clear goal: ${goalErrorMessage(e)}`, 'error');
    }
  }
}

/** Fork a chat, through `turnId` when given. A goal comes along without carrying on by itself. */
async function fork(chatId: string, turnId?: string) {
  const threadId = nativeOf(chatId);
  // a turn of an earlier segment isn't in this thread: fork the whole of it then
  const lastTurnId = turnId && threadId === chatId && !turnId.startsWith('pending-') ? turnId : undefined;
  const r = await native.codex.fork({ threadId, excludeTurns: true, deferGoalContinuation: true, ...(lastTurnId ? { lastTurnId } : {}) });
  upsertThread(r.thread, true);
  copyChatConfig(chatId, r.thread.id);
  // the fork runs on the account the user put this chat on; if that can't be kept, it is said
  await inheritCodexPin(chatId, r.thread.id).catch((e) =>
    toast(`The fork couldn't keep this chat's account (${errorText(e)}); it uses the pool's`, 'error'),
  );
  navigate({ name: 'thread', id: r.thread.id });
  toast('Forked into a new chat');
  return r.thread.id as string;
}

export const CODEX_HANDLERS: Partial<Record<Semantic, SemanticHandler>> = ownTable({
  // args: pause | resume | clear | budget <tokens|none> | edit <objective>
  goal: ({ chatId, args }) =>
    args === 'pause'
      ? pauseCodexGoal(chatId)
      : args === 'resume'
        ? resumeGoal(chatId)
        : args.startsWith('budget ')
          ? setGoalBudget(chatId, args.slice(7))
          : args.startsWith('edit ')
            ? editGoal(chatId, args.slice(5))
            : args === 'clear' || args === 'clear human'
              ? clearGoal(chatId)
              : unsupportedGoal('Codex', args),
  rename: ({ chatId, args }) => codexApi.threadRename(chatId, args),
  shell: ({ chatId, args }) => withLease(chatId, 'thread/shellCommand', { command: args }),
  fork: ({ chatId, args }) => fork(chatId, args || undefined),
  // args: the turn to go back to before; true once the thread is reverted
  rewind: ({ chatId, args }) => revertThread(chatId, args),
});
