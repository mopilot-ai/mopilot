// The agent a new chat on a picked machine folder would start on, from that machine's readiness (null when no machine folder is picked).
import { useStore } from '../store/core';
import { savedDefaultHarness } from '../store/chats';
import { newChatHostPick } from '../store/projects';
import { useHostMachines, type HostMachineRow } from '../lib/hostMachines';
import type { AppState } from '../store/state';
import { agentIdOf, chooseHostAgent, type HostAgentChoice } from '../harness/hostAgent';

/** `pick` is the folder on the machine, `want` the agent asked for (the folder's own, else the saved default); `choice` is null while the machine's readiness is not known. */
export type HostAgentView = {
  pick: NonNullable<AppState['newChatHost']>;
  want: string;
  machine: HostMachineRow | null;
  choice: HostAgentChoice | null;
};

export function useHostAgentChoice(): HostAgentView | null {
  const pick = useStore((s) => newChatHostPick(s));
  const saved = useStore((s) => s.newChatHarnessPick ?? savedDefaultHarness(s));
  const { machines } = useHostMachines();
  if (!pick) return null;
  const machine = machines.find((m) => m.id === pick.id) ?? null;
  const want = pick.agent ?? agentIdOf(saved);
  return { pick, want, machine, choice: chooseHostAgent(want, machine?.agents ?? [], pick.name) };
}
