// Whether the chat's agent needs a sign-in on the machine the chat runs on (or the new chat was pointed at): the one answer the sign-in card above the composer and the Send button both follow, so they never disagree.
import { hostFamilyOfHarness } from '../../shared/host/chatIds.mjs';
import { useHostAccess } from '../lib/host';
import { type HostMachineRow, type MachineAgent, useHostMachines } from '../lib/hostMachines';
import { useChatOwner } from '../lib/hostOwner';
import { useStore } from '../store/core';
import { newChatHostPick } from '../store/projects';
import { useHostAgentChoice } from './useHostAgentChoice';

/** The machine and the agent on it; `standIn`: a new chat starts on another agent that is ready there, so sending is not blocked by this one, and `standInLabel` names it. */
export type HostSigninNeed = { machine: HostMachineRow; agent: MachineAgent; standIn: boolean; standInLabel: string | null };

/**
 * The chat's machine and its agent there, while the machine answers and lists that agent (a signed-out one or not); null on this Mac, without Host, or when the machine does not list it.
 * @param agent the chat's agent: a first-tier harness id or a basic agent's id (`host-claude` reads as Claude Code); a new chat asks for the agent its pick wants (useHostAgentChoice), the one the routing note names
 */
export function useHostAgentThere(threadId: string | null, agent: string | null): HostSigninNeed | null {
  const allowed = useHostAccess();
  const { ownerId } = useChatOwner(threadId);
  const picked = useStore((s) => (threadId ? null : (newChatHostPick(s)?.id ?? 'local')));
  const { machines } = useHostMachines();
  const choice = useHostAgentChoice();
  const machineId = picked ?? ownerId;
  const asked = (threadId ? null : choice?.want) ?? agent;
  const agentId = asked ? (hostFamilyOfHarness(asked) ?? asked) : null;
  const machine = machineId === 'local' ? undefined : machines.find((m) => m.id === machineId);
  const there = machine?.status === 'offline' ? undefined : machine?.agents?.find((a) => a.id === agentId);
  if (!allowed || !machine || !there) return null;
  const standInId = !threadId && choice?.choice?.harness && choice.choice.harness !== there.id ? choice.choice.harness : null;
  const standInLabel = standInId ? (machine.agents?.find((a) => a.id === standInId)?.label ?? standInId) : null;
  return { machine, agent: there, standIn: !!standInId, standInLabel };
}

/** Why Send is off: the chat's agent is signed out on its machine and nothing stands in for it ("Sign in first"), else null. */
export function useSendBlock(threadId: string | null, agent: string | null): string | null {
  const need = useHostAgentThere(threadId, agent);
  return need && need.agent.state === 'signin' && !need.standIn ? 'Sign in first' : null;
}
