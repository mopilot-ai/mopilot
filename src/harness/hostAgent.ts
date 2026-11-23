// Which agent a new chat on a remote machine starts on: judged by that machine's own per-agent readiness (ready, signin, missing), never by what this Mac has signed in.
import type { HarnessKind } from './adapter';
import { acpHarnessOf } from './types';
import { agentLabel } from '../../shared/host/agentReadiness.mjs';
import type { MachineAgent } from '../lib/hostMachines';

export interface HostAgentChoice {
  /** the agent id the chat starts on ('claude', 'codex' or a basic agent's id), or null when none is ready on the machine */
  harness: string | null;
  /** the agents the machine can run now, in the order it lists them */
  offered: MachineAgent[];
  /** the saved pick when the machine could not run it (the reason to show), else null */
  blocked: MachineAgent | null;
  /** one line for the composer when `harness` is not the pick (or nothing is ready), else null */
  note: string | null;
}

/** The agent id a saved kind names: 'claude' and 'codex' as they are, 'acp:kimi' as 'kimi'. */
export const agentIdOf = (kind: HarnessKind): string => acpHarnessOf(kind) ?? kind;

/**
 * Resolve the agent for a machine from its row. `want` is the pick (the saved default, or the one chosen for this
 * folder). Returns null while the row reports no readiness at all (an older Host): the caller keeps its own rule then.
 */
export function chooseHostAgent(want: string, agents: readonly MachineAgent[], machine: string): HostAgentChoice | null {
  const known = agents.filter((a) => a.state !== null);
  if (!known.length) return null;
  const offered = known.filter((a) => a.state === 'ready');
  const own = known.find((a) => a.id === want);
  if (own?.state === 'ready') return { harness: want, offered, blocked: null, note: null };
  const stand = offered[0];
  // an agent the machine does not list at all is as missing as one it lists without a binary
  const blocked = own ?? { id: want, label: agentLabel(want), state: 'missing' as const, reason: `Not installed on ${machine}` };
  const why = blocked.reason || `isn’t ready on ${machine}`;
  if (!stand) return { harness: null, offered, blocked, note: `${blocked.label}: ${why}. No agent is ready on ${machine}` };
  return { harness: stand.id, offered, blocked, note: `${blocked.label}: ${why}; new chats start in ${stand.label}` };
}
