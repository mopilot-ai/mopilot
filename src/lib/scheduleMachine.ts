// A scheduled task's "Runs on": this Mac or one of the user's machines, the agents a machine can run it with, and the one line that says how a run there gets its sign-in (shared/scheduleTask.mjs host_id; main starts it through electron/host/machineChatStart.cjs).
import { machineHarnessOf, type RunWith } from '../../shared/scheduleTask.mjs';
import { isHostFamily } from '../../shared/host/chatIds.mjs';
import type { HostMachineRow, MachineAgent } from './hostMachines';

/** The "Runs on" value for this Mac; any other is a machine's id. */
export const THIS_MAC = 'local';

/** The agent id a machine's row names for a harness: 'claude', 'codex' or a basic agent's id. */
export const agentIdOf = (h: RunWith) => machineHarnessOf({ harness: h });

/** The harness a task runs with for an agent a machine lists. */
export const runWithOfAgent = (id: string): RunWith => (isHostFamily(id) ? id : `acp:${id}`);

/** A "Runs on" row's hint: Offline, else what needs doing; empty when it is ready. */
export function machineHint(m: HostMachineRow): string {
  if (m.status === 'offline') return 'Offline';
  if (m.status === 'attention') return m.agents.find((a) => a.state === 'signin')?.reason || 'Needs attention';
  return '';
}

/** The agents a task can run with on a machine: every installed one, a signed-out one marked (it can still be picked and signed in later). */
export function machineRunWith(m: HostMachineRow | undefined): { id: RunWith; label: string; note: string; disabled: boolean }[] {
  return (m?.agents ?? [])
    .filter((a) => a.state !== 'missing')
    .map((a) => ({ id: runWithOfAgent(a.id), label: a.label, note: a.state === 'signin' ? 'Needs sign-in' : '', disabled: false }));
}

/** How a run of this harness on the machine gets its sign-in, before Save: the tone draws the line as fine or as a warning. */
export function machineCredential(m: HostMachineRow | undefined, harness: RunWith, label: string): { text: string; tone: 'ok' | 'warn' } {
  if (!m) return { text: "This machine isn't in your list", tone: 'warn' };
  const agent: MachineAgent | undefined = m.agents.find((a) => a.id === agentIdOf(harness));
  const away = m.status === 'offline' ? ' · Offline now' : '';
  if (!agent || agent.state === 'missing') return { text: `${label} isn't installed on ${m.name}`, tone: 'warn' };
  if (agent.state === 'signin') return { text: `Sign in to ${label} on ${m.name}`, tone: 'warn' };
  if (agent.unsure) return { text: `Couldn’t check ${label} on ${m.name}${away}`, tone: 'warn' };
  if (agent.lent) return { text: `Uses this Mac's key · needs this Mac online${away}`, tone: 'ok' };
  return { text: `Signed in on ${m.name}${away}`, tone: 'ok' };
}

/** Who fires a task on a machine, for the dialog's note: the machine itself when its agent is signed in there, else this Mac (a lent key needs it). */
export const machineWhere = (name: string, ownSignIn: boolean) =>
  ownSignIn ? `${name} runs it on schedule, even while this Mac is off.` : `This Mac starts each run on ${name}, so it needs this Mac on.`;

/** Whether the agent a task runs with is signed in on the machine itself (not lent this Mac's key). */
export const ownSignIn = (m: HostMachineRow | undefined, harness: RunWith) => {
  const agent = m?.agents.find((a) => a.id === agentIdOf(harness));
  return !!agent && agent.state !== 'missing' && agent.state !== 'signin' && !agent.lent && !agent.unsure;
};
