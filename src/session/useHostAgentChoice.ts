// The agent a new chat on a picked machine folder would start on, from that machine's readiness (null when no machine folder is picked).
import { useStore } from '../store/core';
import { startingHarness } from '../store/chats';
import { newChatHostPick } from '../store/projects';
import { useHostMachines, type HostMachineRow } from '../lib/hostMachines';
import type { AppState } from '../store/state';
import { chooseHostAgent, wantedHostAgent, type HostAgentChoice } from '../harness/hostAgent';

/** `pick` is the folder on the machine, `want` the agent asked for (wantedHostAgent: the folder's own, the draft's, the machine's last, else the saved default); `choice` is null while the machine's readiness is not known. */
export type HostAgentView = {
  pick: NonNullable<AppState['newChatHost']>;
  want: string;
  machine: HostMachineRow | null;
  choice: HostAgentChoice | null;
};

export function useHostAgentChoice(): HostAgentView | null {
  const pick = useStore((s) => newChatHostPick(s));
  const draft = useStore((s) => s.newChatHarnessPick);
  const saved = useStore((s) => s.newChatHarnessPick ?? startingHarness(s));
  const remembered = useStore((s) => (pick ? s.prefs?.hostPicks?.[pick.id]?.agent : undefined));
  const { machines } = useHostMachines();
  if (!pick) return null;
  const machine = machines.find((m) => m.id === pick.id) ?? null;
  const want = wantedHostAgent({ pick: pick.agent, draft, remembered, saved, agents: machine?.agents ?? [] });
  return { pick, want, machine, choice: chooseHostAgent(want, machine?.agents ?? [], pick.name) };
}
