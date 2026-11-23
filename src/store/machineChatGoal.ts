// The goal bar's actions and a typed /goal on a chat on a machine: the machine's agent runs them (`chat.goal`), the same request set a chat on this Mac sends its own app-server, and the goal it answers with is the chat's from now on. A refusal comes back as one short line.
import { native } from '../lib/native';
import { parseTokenBudget } from '../lib/codexGoals';
import { refusalWords } from '../../shared/host/refusalWords.mjs';
import { toast } from './core';
import { setGoalState } from './actions';

/** What each action says when it fails, as the same action's failure reads on this Mac. */
const FAILED = {
  pause: 'pause goal',
  resume: 'resume goal',
  extend: 'add rounds to the goal',
  clear: 'clear goal',
  budget: 'set the budget',
  edit: 'edit goal',
};

type Wire = { action: keyof typeof FAILED; human?: boolean; tokens?: number | null; objective?: string };

/** The Host's refusal as one line: its own words, or "too old" for a Host that has no goal controls. */
export function goalRefusal(e: unknown): string {
  const x = e as { code?: string; message?: string } | null;
  if (x?.code === 'feature_missing') return refusalWords('feature_missing', { machine: 'The machine' })!.line;
  return x?.message || 'The machine could not change the goal.';
}

/** A goal request as the wire has it, from the semantic's arguments (pause, resume, extend, clear, clear human, budget <tokens|none>, edit <objective>); null for a budget that is not one. */
function wireOf(args: string): Wire | null {
  if (args.startsWith('budget ')) {
    const tokens = parseTokenBudget(args.slice(7));
    return tokens === undefined ? null : { action: 'budget', tokens };
  }
  if (args.startsWith('edit ')) return { action: 'edit', objective: args.slice(5) };
  if (args === 'clear human') return { action: 'clear', human: true };
  if (args === 'clear') return { action: 'clear' };
  if (args === 'pause' || args === 'resume' || args === 'extend') return { action: args };
  throw new Error(`Unknown goal action ${args}`);
}

/**
 * Run a goal action on a chat on a machine. Resolves what the semantic handlers resolve for the action on this Mac (an edit: whether it went through); a refusal is a toast, not a throw.
 * @param chatId the chat on the machine @param args the semantic's arguments
 */
export async function runMachineGoal(chatId: string, args: string): Promise<boolean | undefined> {
  const wire = wireOf(args);
  if (!wire) return void toast('Budget: a number of tokens like 200k, or none', 'error');
  try {
    const { goal } = await native.host.goalChat(chatId, wire);
    // the state lane says it too; this is the answer to the press
    await setGoalState(chatId, goal);
    return wire.action === 'edit' ? true : undefined;
  } catch (e) {
    toast(`Couldn't ${FAILED[wire.action]}: ${goalRefusal(e)}`, 'error');
    return wire.action === 'edit' ? false : undefined;
  }
}
