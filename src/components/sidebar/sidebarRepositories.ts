// Repository and checkout facts requested for distinct sidebar folders, with replies scoped to the current inputs.
import { useCallback, useEffect, useState } from 'react';
import { machineFolderOf } from '../../lib/machineFolder';
import { machineProjectPath } from '../../lib/machineProject';
import { native } from '../../lib/native';
import { isAbsolutePath } from '../../lib/paths';
import type { ProjectGroupData } from './projectGroups';

type Probe = [host: string, path: string, status: string, scope: string];
type Machine = { id: string; status: string; repositoryScope?: string };
const folderIdentity = (host: string, path: string, scope: string) => JSON.stringify([host, path, scope]);
type Read = (host: string, path: string, scope: string) => Promise<string | null | undefined> | undefined;

function useFolderFacts(probes: Probe[], readFolder: Read) {
  const [facts, setFacts] = useState<ReadonlyMap<string, string>>(new Map());
  const key = JSON.stringify([...new Set(probes.map((probe) => JSON.stringify(probe)))].sort());
  useEffect(() => {
    const targets: string[] = JSON.parse(key);
    if (!targets.length) return;
    let read = 0;
    const refresh = () => {
      const sequence = ++read;
      for (const target of targets) {
        const [host, path, , scope]: Probe = JSON.parse(target);
        const identity = folderIdentity(host, path, scope);
        void readFolder(host, path, scope)?.then(
          (value) => {
            if (sequence !== read || value === undefined) return;
            setFacts((old) => {
              if ((old.get(identity) ?? null) === value) return old;
              const next = new Map(old);
              if (value) next.set(identity, value);
              else next.delete(identity);
              return next;
            });
          },
          () => undefined,
        );
      }
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      read++;
      window.removeEventListener('focus', refresh);
    };
  }, [key, readFolder]);
  return facts;
}

const readRepository: Read = (host, path, scope) =>
  host
    ? native.host?.sidebarRepository?.(host, { path, ...(scope && { expectedHostKey: scope }) }).then((reply) => reply.value)
    : native.git?.sidebarRepository?.(path);

export function useSidebarRepositories(groups: ProjectGroupData[], machines: readonly Machine[], needed: boolean) {
  const probes = needed
    ? groups.flatMap((group): Probe[] => {
        if (!group.path) return [];
        const host = group.machine?.id ?? '';
        const machine = machines.find((m) => m.id === host);
        if (host && !machine) return [];
        return [[host, group.path, machine?.status ?? '', machine?.repositoryScope ?? '']];
      })
    : [];
  return useFolderFacts(probes, readRepository);
}

export function folderRepository(facts: ReadonlyMap<string, string>, group: ProjectGroupData, machines: readonly Machine[]) {
  const host = group.machine?.id ?? '';
  const machine = machines.find((m) => m.id === host);
  if (host && !machine) return undefined;
  return facts.get(folderIdentity(host, group.path, machine?.repositoryScope ?? ''));
}

const readCheckout: Read = (host, path, scope) =>
  native.host?.sidebarRepository?.(host, { path, checkout: true, ...(scope && { expectedHostKey: scope }) }).then(({ value }) => {
    if (value === null || (typeof value === 'string' && isAbsolutePath(value))) return value;
    return undefined;
  });

/** Resolve a Host folder to its checkout, with the managed-worktree convention available before Git answers. */
export function useMachineCheckouts(keys: readonly string[], machines: readonly Machine[]) {
  const byId = new Map(machines.map((machine) => [machine.id, machine]));
  const probes = keys.flatMap((key): Probe[] => {
    const folder = machineFolderOf(key);
    if (!folder?.path) return [];
    const machine = byId.get(folder.machineId);
    if (!machine) return [];
    return [[machine.id, folder.path, machine.status, machine.repositoryScope ?? '']];
  });
  const facts = useFolderFacts(probes, readCheckout);
  return useCallback(
    (id: string, cwd: string) => {
      const machine = machines.find((row) => row.id === id);
      return (machine && facts.get(folderIdentity(id, cwd, machine.repositoryScope ?? ''))) || machineProjectPath(cwd);
    },
    [facts, machines],
  );
}
