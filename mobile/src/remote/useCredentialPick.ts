// What a new chat on a machine will use, and the person's pick of another source: the line the Host's own report gives for the picked agent, the sources to choose among, and a pick that belongs to one agent on one machine.
import { useState } from 'react';
import { credentialChoices, credentialLine } from './credentialLine';
import type { CredentialSource, Machine } from './machines';

/** @param where the machine pick of New chat @param harness the agent picked */
export function useCredentialPick(where: { remote: boolean; host: string; machine: Machine | null }, harness: string | null | undefined) {
  // null: the machine's own order, which the Host enforces and the line names
  const [picked, setPicked] = useState<{ of: string; source: CredentialSource | null } | null>(null);
  const agent = where.remote ? where.machine?.agents.find((a) => a.id === harness) : undefined;
  const machineName = where.machine?.name ?? '';
  const of = `${where.host}/${harness}`;
  return {
    agent,
    machineName,
    using: credentialLine(agent, machineName),
    choices: credentialChoices(agent, machineName),
    source: picked?.of === of ? picked.source : null,
    setSource: (next: CredentialSource | null) => setPicked({ of, source: next }),
  };
}
