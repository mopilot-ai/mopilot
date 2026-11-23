// What a machine can take of a chat's agent, said before the press (from the machine's own agents) and after a refusal (by the fact that holds), in the Host's words (#4909).
import { CONTINUE_REFUSAL_COPY } from '../../../shared/host/continue.mjs';
import { hostFamilyOfHarness } from '../../../shared/host/chatIds.mjs';
import type { Machine } from './machines';

/** The chat's agent as the screen knows it: the id the Mac names it by and its label. */
export type ChatAgent = { id: string; label: string };

/** The Mac's own refinement of a signed-out target whose login the Host refused (shared/host/continue.mjs does not word it: the Mac's Switch host dialog does). */
const COPY: Record<string, string> = {
  ...CONTINUE_REFUSAL_COPY,
  agent_login_refused: "{agent}'s login on {machine} is refused. Sign in again.",
};

const fill = (text: string, machine: string, agent: string) => text.replace('{agent}', agent).replace('{machine}', machine);

/** The machine's id for an agent from the id a chat names it by: `claude`, `codex`, an ACP agent as `acp:kimi`, a Host chat's `acp:host-claude`. */
export function agentIdOf(id: string | undefined): string | null {
  const bare = id?.trim().replace(/^acp:/, '');
  return bare ? (hostFamilyOfHarness(bare) ?? bare) : null;
}

/** A refusal's sentence by the fact that holds, for a machine and an agent; null for a code that is not one of these. */
export function refusalCopy(code: string | undefined, machine: string, agent: string): string | null {
  return code && Object.hasOwn(COPY, code) ? fill(COPY[code], machine, agent) : null;
}

/**
 * Why a machine cannot take the chat's agent, from what the machine itself reports (its agents): not installed, or signed out (the Host's own words with
 * the login to use, else the shared sentence). null when nothing says it cannot: this Mac, a machine that is not online, a machine that lists no row for the
 * agent (the Host decides at the press), or an agent that is ready.
 */
export function cannotTake(machine: Machine, agent: ChatAgent | null | undefined): string | null {
  const id = agentIdOf(agent?.id);
  if (!agent || !id || machine.id === 'local' || machine.status !== 'online') return null;
  const row = machine.agents.find((a) => a.id === id);
  if (row?.state === 'missing') return refusalCopy('agent_missing', machine.name, agent.label);
  if (row?.state === 'signin') return row.reason || refusalCopy('agent_signed_out', machine.name, agent.label);
  return null;
}

/** The code a failed request carries: on the error itself, or on the one it was made from (a request bound to the screen keeps the original as its cause). */
export function refusalCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === 'string' ? code : undefined;
}

/** What a failed move says: the Host's sentence for a refusal it can name, in the machine's name and the agent's; null for any other failure (the caller shows the Mac's words as they are). */
export function moveRefusal(error: unknown, machine: string, agent: string | undefined): string | null {
  return refusalCopy(refusalCode(error), machine, agent ?? 'This agent');
}
