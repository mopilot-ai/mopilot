// Repository facts requested for distinct sidebar folders, with replies scoped to the current inputs.
import { useEffect, useState } from 'react';
import { native } from '../../lib/native';
import { groupKey } from '../../lib/projectGroupOrder';
import type { ProjectGroupData } from './projectGroups';

type Probe = [key: string, host: string, path: string, status: string, scope: string];
type Machine = { id: string; status: string; repositoryScope?: string };
const folderIdentity = (key: string, host: string, path: string, scope: string) => JSON.stringify([key, host, path, scope]);

export function useSidebarRepositories(groups: ProjectGroupData[], machines: readonly Machine[], needed: boolean) {
  const [facts, setFacts] = useState<ReadonlyMap<string, string>>(new Map());
  const probes = JSON.stringify(
    needed
      ? groups.flatMap((group): Probe[] => {
          if (!group.path) return [];
          const host = group.machine?.id ?? '';
          const machine = machines.find((m) => m.id === host);
          if (host && !machine) return [];
          return [[groupKey(group), host, group.path, machine?.status ?? '', machine?.repositoryScope ?? '']];
        })
      : [],
  );
  useEffect(() => {
    const targets: Probe[] = JSON.parse(probes);
    if (!targets.length) return;
    let read = 0;
    const refresh = () => {
      const sequence = ++read;
      for (const [key, host, path, , scope] of targets) {
        const request = host
          ? native.host?.sidebarRepository?.(host, { path }).then((reply) => reply.value)
          : native.git?.sidebarRepository?.(path);
        void request?.then(
          (repo) => {
            if (sequence !== read || repo === undefined) return;
            const identity = folderIdentity(key, host, path, scope);
            setFacts((old) => {
              if ((old.get(identity) ?? null) === repo) return old;
              const next = new Map(old);
              if (repo) next.set(identity, repo);
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
  }, [probes]);
  return facts;
}

export function folderRepository(facts: ReadonlyMap<string, string>, group: ProjectGroupData, machines: readonly Machine[]) {
  const host = group.machine?.id ?? '';
  const machine = machines.find((m) => m.id === host);
  if (host && !machine) return undefined;
  return facts.get(folderIdentity(groupKey(group), host, group.path, machine?.repositoryScope ?? ''));
}
