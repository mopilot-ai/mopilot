// Which plan a chat's turn box shows and when, as Claude Desktop's turn box decides it: the latest turn's own plan, else
// the agent's list, else an earlier turn's own plan; one not updated since the user's latest message is the plan from
// before it (shown while a turn runs, without spinning, and gone once every step is done); and when no turn runs, only
// a plan a turn left unfinished (stopped or failed), or one linked sessions or background tasks still work on.
import type { OrchestrationView } from '../../shared/orchestration';
import { memoByObject } from '../lib/memoByObject';
import type { ThreadItem, TurnPlanStep, TurnState } from './types';

const STATUS = { pending: 'pending', in_progress: 'inProgress', completed: 'completed' } as const;
const agentSteps = memoByObject((plan: OrchestrationView['plans'][string]) =>
  plan.items.map((s) => ({ step: s.content, status: STATUS[s.status] })),
);

export type BoxPlan = { steps: TurnPlanStep[]; stale: boolean };

/**
 * The messages steered into a turn after the one that opened it (main's deliveries counted too, so a count taken
 * earlier compares with it). The opener is left out: it can join the turn after the turn's first events, when the
 * harness's notifications beat main's answer to the send, and it is never a message after the turn's plan.
 */
export function steeredMessages(t: Pick<TurnState, 'items'>): number {
  return Math.max(0, t.items.filter((i) => i.type === 'userMessage').length - 1);
}

/** Whether any of `turns` carries a message the user sent (not one main delivered: a wake-up, a brief). */
function userSpoke(turns: TurnState[], delivered: (item: ThreadItem) => boolean): boolean {
  return turns.some((t) => t.items.some((i) => i.type === 'userMessage' && !delivered(i)));
}

/**
 * The plan to show for a chat whose turns are `turns` (oldest first) and whose agent keeps `agent` (update_task_list).
 * `delivered`: whether a thread item is one main delivered rather than the user's own.
 */
export function boxPlan(
  turns: TurnState[],
  agent: OrchestrationView['plans'][string] | undefined,
  delivered: (item: ThreadItem) => boolean,
): BoxPlan | null {
  const latest = turns.at(-1);
  const own = latest?.plan;
  if (own?.steps.length) return { steps: own.steps, stale: own.steered !== undefined && steeredMessages(latest!) > own.steered };
  if (agent?.items.length) return { steps: agentSteps(agent), stale: agent.stale };
  for (let i = turns.length - 2; i >= 0; i--) {
    const steps = turns[i].plan?.steps;
    if (steps?.length) return { steps, stale: userSpoke(turns.slice(i + 1), delivered) };
  }
  return null;
}

/**
 * Whether the box shows `plan` for the chat's latest turn (`status`; none before the first) and whether its open step
 * spins: while the turn runs, unless the plan is from before the user's latest message (then it shows still, and not
 * at all once done). After the turn, a fresh plan with steps left keeps spinning while work on it goes on: linked
 * sessions (`childrenRunning`) or the chat's background tasks (`tasksRunning`); one the turn was cut short on (stopped
 * or failed) shows frozen, and a finished one stays only while linked sessions work or wait.
 */
export function boxShows(
  plan: BoxPlan,
  status: TurnState['status'] | undefined,
  childrenWorking: boolean,
  tasksRunning = false,
  childrenRunning = childrenWorking,
) {
  const open = plan.steps.some((s) => s.status !== 'completed');
  if (status === 'inProgress') return plan.stale && !open ? null : { spin: open && !plan.stale };
  if (plan.stale) return null;
  if ((status === 'interrupted' || status === 'failed') && open) return { spin: false };
  if (open && (childrenRunning || tasksRunning)) return { spin: true };
  return childrenWorking ? { spin: false } : null;
}
