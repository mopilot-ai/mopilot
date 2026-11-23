// Location icons and disambiguating labels for the listed sidebar projects.
import { hostLocationKind, type HostLocationKind } from '../../lib/hostLocation';
import type { HostMachineRow } from '../../lib/hostMachines';
import { parentHint } from '../../lib/paths';
import type { ProjectGroupData } from './projectGroups';
import { projectSessionLocations } from './projectRows';

export const usesMixedLocationMark = (kinds: readonly HostLocationKind[]) => kinds.length > 2;

/** The row's visible label, scoped to projects that use the same icon. */
function projectLabelKey(group: ProjectGroupData, hint?: string): string {
  if (!group.locationKinds) return `local:${group.name.toLowerCase()}`;
  const label = [group.name, hint]
    .filter(Boolean)
    .join(' · ')
    .replaceAll('\u200b', '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .normalize('NFC');
  const glyphs = usesMixedLocationMark(group.locationKinds) ? 'mixed' : group.locationKinds.join(',');
  return `${glyphs}:${label}`;
}

/** Prefer a machine name for same-named projects on different machines. Add a path suffix when that still ties. */
export function labelProjects(
  groups: ProjectGroupData[],
  machines: readonly HostMachineRow[],
  ownerOf: (id: string) => string | null,
  descendants: ReadonlyMap<string, readonly string[]>,
) {
  const byName = new Map<string, ProjectGroupData[]>();
  const clouds = new Map(machines.map((machine) => [machine.id, machine.cloud]));
  const kindOf = (id: string) => hostLocationKind(id, clouds.get(id));
  for (const g of groups) {
    const { shared, hosts } = projectSessionLocations(g, ownerOf, descendants);
    g.sessionHostId = shared;
    const kinds = new Set(hosts.map(kindOf));
    if (g.machine) kinds.add(kindOf(g.machine.id));
    if (g.cloudTasks?.length) kinds.add('cloud');
    // A pinned project with no sessions can still name the places it can start one.
    if (!g.threads.length && !g.starting?.length && !g.cloudTasks?.length) {
      for (const location of g.locations ?? []) kinds.add(location.kind === 'cloud' ? 'cloud' : kindOf(location.id));
    }
    if (kinds.size) g.locationKinds = [...kinds].sort();
    // A repository-only group's hint already names its owner. It has no folder to disambiguate by.
    if (g.repositoryKey) continue;
    const k = projectLabelKey(g);
    byName.set(k, [...(byName.get(k) ?? []), g]);
  }
  for (const same of byName.values()) {
    if (same.length < 2) continue;
    const counts = new Map<string, number>();
    for (const g of same) {
      const name = g.machine?.name ?? '';
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (let depth = 1; depth <= 3; depth++) {
      for (const g of same) {
        const name = g.machine?.name;
        const machineHint = counts.size > 1 ? name : undefined;
        g.hint = name && counts.get(name) === 1 ? name : [machineHint, parentHint(g.path, depth)].filter(Boolean).join(' · ');
      }
      if (new Set(same.map((g) => g.hint)).size === same.length) break;
    }
  }
  // Project and device names can include the same separator used for hints.
  const used = new Set<string>();
  for (const g of groups) {
    if (!g.locationKinds) continue;
    if (used.has(projectLabelKey(g, g.hint))) {
      const pathHint = [g.hint, g.repositoryKey ? g.repository : g.path].filter(Boolean).join(' · ');
      g.hint = pathHint;
      for (let suffix = 2; used.has(projectLabelKey(g, g.hint)); suffix++) g.hint = `${pathHint} (${suffix})`;
    }
    used.add(projectLabelKey(g, g.hint));
  }
}
