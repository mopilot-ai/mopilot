// Owns local Plan toggle state and refuses the app's Plan mode while a composer targets a machine or its owner is unresolved.
import { useState } from 'react';
import { useComposerLocation } from '../../session/useComposerLocation';
import { useHostMachines } from '../../lib/hostMachines';
import { useHostAgentChoice } from '../../session/useHostAgentChoice';
import { hostFamilyOfHarness } from '../../../shared/host/chatIds.mjs';
import { hostPermissionFamily } from '../../../shared/host/permissions.mjs';
import type { HarnessId } from '../../harness/types';
import { blocked } from './ComposerCommands';
import { setSession } from '../../store/session/useSession';
import { toast } from '../../store/core';

/**
 * `chat`: the agent the chat runs on (a new chat: the one picked to run on the machine); its family is its id in a machine's agent list. On a machine Plan is the Host's, kept on the chat there: the app offers it for an agent whose
 * row says the machine's Host takes it (`planMode`), and refuses it otherwise with the machine's name (an older Host says nothing).
 */
export function useComposerPlan(
  threadId: string | null,
  sessionPlan: boolean,
  chat: { harness: HarnessId | null; basic: string | null } = { harness: null, basic: null },
) {
  const choice = useHostAgentChoice();
  const agent = threadId
    ? chat.basic
      ? hostFamilyOfHarness(chat.basic)
      : chat.harness
    : hostPermissionFamily(choice?.choice?.harness ?? choice?.want ?? '');
  const [draftPlan, setDraftPlan] = useState(false);
  const { machine, machineId, pending } = useComposerLocation(threadId);
  const { machines } = useHostMachines();
  const hostTakesPlan =
    !!machineId && !!agent && !!machines.find((m) => m.id === machineId)?.agents.some((a) => a.id === agent && a.planMode === true);
  const planOffWhy = pending
    ? 'Checking where this chat runs.'
    : machine && !hostTakesPlan
      ? `Plan mode isn't available on ${machine} yet.`
      : null;
  // the machine is not listed (loading, offline): nothing is known of what its Host takes, so a chat keeps showing the Plan it is in, and a send of it to a Host that cannot take it is refused, never sent without Plan. A machine that is listed and does not take Plan for the agent hides a stored Plan (it is only a stale flag from before the chat moved).
  const machineListed = !!machineId && machines.some((m) => m.id === machineId);
  const planMode = threadId ? sessionPlan && (hostTakesPlan || !machine || !machineListed || pending) : !planOffWhy && draftPlan;
  const setPlanMode = (value: boolean) => {
    if (value && planOffWhy) {
      toast(planOffWhy);
      return false;
    }
    if (value && blocked(threadId, 'plan')) return false;
    return threadId ? void setSession(threadId, { plan: value }) : setDraftPlan(value);
  };
  return { planMode, setPlanMode, planOffWhy };
}

/** Native ACP commands belong to the agent; only app-owned Plan entries follow the app toggle's availability. */
export function planCommandOff(command: { name: string; dispatch: string }, reason: string | null): string | undefined {
  return command.name === 'plan' && command.dispatch !== 'passthrough' ? (reason ?? undefined) : undefined;
}
