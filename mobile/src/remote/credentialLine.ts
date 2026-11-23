// What a machine chat will use, in words, before its first message (#4667): the line a person reads on New chat and on an open chat, and the sources they may choose between. The Host says which one is in use (`using`); nothing here knows an order.
import type { CredentialSource, MachineAgent } from './machines';

/** The words for each source; `machine` is the machine's own name. A key is pay per use, so it says so. */
export function sourceWords(source: CredentialSource, machine: string): string {
  return source === 'own' ? `Signed in on ${machine}` : source === 'key' ? "Your Mac's key · pay per use" : "Your organization's access";
}

/** The line naming what a chat on this agent will use, or null when the Host does not say (an older Host: nothing is claimed). */
export function credentialLine(agent: Pick<MachineAgent, 'using'> | null | undefined, machine: string): string | null {
  return agent?.using ? sourceWords(agent.using, machine) : null;
}

/**
 * The sources a person may choose between for this agent: every one that exists, only when there is more than one (one is no choice), each with its words
 * and whether it is the one in use now. An agent whose Host does not report sources has none to offer.
 */
export function credentialChoices(
  agent: Pick<MachineAgent, 'using' | 'sources'> | null | undefined,
  machine: string,
): { source: CredentialSource; label: string; inUse: boolean }[] {
  const have = (['own', 'key', 'org'] as const).filter((s) => agent?.sources?.[s]);
  return have.length > 1 ? have.map((source) => ({ source, label: sourceWords(source, machine), inUse: agent?.using === source })) : [];
}
