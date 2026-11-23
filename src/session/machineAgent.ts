// A chat on a machine's data for the failed-turn box, in the shapes the box already takes for This Mac: the agent the chat runs on there (its models and login) and the sign-in recovery that starts the machine's own login.
import { toast, useStore } from '../store/core';
import { chatBasicHarness } from '../store/chats';
import { agentOfKind } from '../store/machineChatSwitch';
import { hostFamilyOfHarness } from '../../shared/host/chatIds.mjs';
import { agentLabel } from '../../shared/host/agentReadiness.mjs';
import { userError } from '../../shared/userError.mjs';
import { useChatMachine } from '../lib/chatMachine';
import { signinKey, startSignin, cancelSignin, useHostSignins, RUNNING } from '../lib/hostSignin';
import { signinStatus } from '../lib/hostSigninCopy';
import { useHostAgentThere } from './useHostSigninNeed';
import { authRecovery, type AuthRecovery } from './chatActions';

/** The machine a chat runs on and its agent there (null `agent` while the machine does not list it); null `machine` for a chat on this Mac. */
export function useMachineAgent(chatId: string) {
  const { machine } = useChatMachine(chatId);
  const here = !!machine;
  const agentId = useStore((s) => {
    if (!here) return '';
    const basic = chatBasicHarness(chatId, s) ?? '';
    return agentOfKind(s.chatConfig?.[chatId]?.hostAgent) ?? hostFamilyOfHarness(basic) ?? basic;
  });
  const saved = useStore((s) => (here ? s.chatConfig?.[chatId]?.hostSelection : undefined));
  const there = useHostAgentThere(chatId, machine ? agentId || null : null);
  return { machine, agentId, agent: there?.agent ?? null, saved };
}

/**
 * The failed turn's sign-in recovery: This Mac's for a chat here; for a chat on a machine the same shape fed by that machine's sign-in (the Host's own login, started from here), named for the machine, with its progress as the waiting row.
 * @param message the turn's error
 */
export function useAuthRecovery(chatId: string, message: string | null | undefined): AuthRecovery | null {
  const base = authRecovery(chatId, message);
  const { machine, agentId, agent } = useMachineAgent(chatId);
  const signins = useHostSignins();
  if (!base || !machine) return base;
  const label = `Sign in on ${machine.name}`;
  // where the machine does not list the agent, its row in Settings stays the way (the base's)
  if (!agent) return { ...base, label };
  const view = signins.get(signinKey(machine.id, agent.id));
  const status = view && RUNNING.has(view.state) ? signinStatus(view, agent.label || agentLabel(agentId)) : null;
  const waiting = status ? (status.code ? `${status.text}: ${status.code}` : status.text) : null;
  return {
    label,
    signIn: () => void startSignin(machine.id, agent.id).catch((e) => toast(userError(e), 'error')),
    waiting: { text: () => waiting, cancel: () => void cancelSignin(machine.id, agent.id) },
  };
}
