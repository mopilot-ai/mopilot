// /goal as typed in the composer: Claude Code runs it itself (the text goes out as typed), Codex sets the
// goal through its app-server (on a machine, the machine's: the message carries `goal`). The composer calls this and doesn't ask which harness the chat is on.
import { parseGoalCommand } from '../../lib/codexGoals';
import { goalOffReason } from '../../lib/goalGate';
import { blockedReason } from '../../store/chats';
import { clearGoal, editGoal, pauseGoal, resumeGoal, setGoalBudget, showGoal } from '../../store/actions';
import { get as getState, toast } from '../../store/core';
import { sendMessage } from '../../store/send';
import { hostAgentOf } from '../../store/machineChatSwitch';
import { onMachineNow } from '../../lib/hostChats';
import type { AppState } from '../../store/state';
import { composerFamily } from './select';

/** Why the Goal entries are greyed for this chat (a temporary one), or null (D-49). */
export function goalOff(threadId: string | null, s: AppState = getState()): string | null {
  return goalOffReason(threadId ? s.threads[threadId] : null, !!threadId, s.newChatTemporary);
}

/** Runs a typed /goal. Resolves false when what it sends didn't go out (sendMessage said why) or an edit failed. */
export async function runGoalCommand(threadId: string | null, args: string) {
  // a chat on a machine is drawn as an ACP chat: the agent its machine runs it on decides, as the agent of a chat here does
  const claude =
    composerFamily(threadId) === 'claude' || (threadId !== null && onMachineNow(threadId) && hostAgentOf(threadId) === 'claude');
  const parsed = parseGoalCommand(args);
  // a token budget is Codex's; to Claude "budget …" is part of the condition
  const cmd =
    claude && (parsed.kind === 'budget' || parsed.kind === 'pause' || parsed.kind === 'resume' || parsed.kind === 'edit')
      ? ({ kind: 'set', objective: args.trim() } as const)
      : parsed;
  const off = goalOff(threadId);
  if (off && cmd.kind === 'set') return toast(off, 'error');
  if (claude) {
    // the command goes out as typed; clearing also stops the loop
    if (cmd.kind === 'clear') return threadId ? clearGoal(threadId, true) : toast('No goal set');
    if (cmd.kind === 'show' && !threadId) return toast('No goal set. Use /goal <condition> to set one.');
    return sendMessage(threadId, cmd.kind === 'set' ? `/goal ${cmd.objective}` : '/goal', [], { human: true });
  }
  const why = blockedReason(threadId, 'goal');
  if (why) return void toast(why, 'error');
  if (cmd.kind === 'show') return showGoal(threadId);
  if (cmd.kind === 'pause') return threadId ? pauseGoal(threadId) : toast('No goal set');
  if (cmd.kind === 'resume') return threadId ? resumeGoal(threadId) : toast('No goal set');
  if (cmd.kind === 'edit') return threadId ? editGoal(threadId, cmd.objective) : toast('No goal set');
  if (cmd.kind === 'clear') return threadId ? clearGoal(threadId) : toast('No goal set');
  if (cmd.kind === 'budget') return threadId ? setGoalBudget(threadId, cmd.tokens) : toast('No goal set');
  // false: main didn't take it, and the composer puts the typed /goal back
  return sendMessage(threadId, cmd.objective, [], { goal: cmd.objective, human: true });
}
