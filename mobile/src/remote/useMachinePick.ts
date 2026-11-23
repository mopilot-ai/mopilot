// Where a new chat runs: this Mac, or one of its Hosts from machines.list; on a Host the agents are that machine's (with why one can't run) and the chat needs a folder there.
import { useEffect, useState } from 'react';
import { useMacLink, useMachines } from '../macLink';
import type { Harness } from './client';
import { lastFolder, rememberFolder } from './lastFolders';
import { agentLine, type Machine } from './machines';

/** A Host's agents as New chat lists them: the ready ones to pick, the rest with the Mac's reason. */
export const hostAgents = (machine: Machine): Harness[] =>
  machine.agents.map((a) => ({
    id: a.id,
    label: a.label,
    detail: agentLine(a, machine.name),
    ...(a.state === 'ready' ? {} : { unavailable: true }),
  }));

/**
 * The machine picked (this Mac until another is), the folder on it, and the agents a new chat may use there. `machines`
 * is null on a Mac without Hosts, which keeps New chat exactly as it is for this Mac alone. A Host that leaves the list
 * puts the pick back on this Mac.
 */
export function useMachinePick(local: Harness[]) {
  const machines = useMachines();
  const { pairId } = useMacLink();
  const [host, setHost] = useState('local');
  const [folder, setFolder] = useState<string | null>(null);
  const machine = machines?.find((m) => m.id === host) ?? null;
  const remote = host !== 'local' && machine !== null;
  useEffect(() => {
    if (host !== 'local' && !machine) {
      setHost('local');
      setFolder(null);
    }
  }, [host, machine]);
  return {
    machines,
    machine,
    host,
    /** Another machine: the folder a chat last used there, else none (a folder is picked there anew). */
    pick: (id: string) => {
      if (id === host) return;
      setHost(id);
      setFolder(id === 'local' ? null : lastFolder(pairId, id));
    },
    /** A chat started in this folder on the picked machine: it is offered first next time. */
    remember: (used: string) => rememberFolder(pairId, host, used),
    folder,
    setFolder,
    remote,
    harnesses: remote ? hostAgents(machine) : local,
  };
}
