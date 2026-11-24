// What the sidebar remembers of its folder groups: the folders chats ran in (so a group outlives its last chat) and the order of its groups, with a machine's folder kept under its machine's key.
import { samePath } from '../../lib/paths';
import { machineFolderKey, machineFolderOf } from '../../lib/machineFolder';
import { groupKey } from '../../lib/projectGroupOrder';
import { machineProjectKey, machineProjectPath } from '../../lib/machineProject';
import type { ProjectGroupData } from './projectGroups';

/** The saved-folder entry of a folder group: its path on this Mac, or its machine's key. */
export const folderEntryOf = (g: Pick<ProjectGroupData, 'path' | 'machine' | 'repositoryKey'>): string =>
  g.repositoryKey ?? machineFolderKey(g.machine?.id ?? '', g.path);

/**
 * The prefs to save so folders chats ran in are remembered and new groups take a place in the order, or null when nothing changes. A bare path an older version saved for a machine's folder becomes that machine's key (when no chat of this Mac's runs in that path), so the folder neither shows twice nor is lost.
 * @param resolve this Mac's real path of a folder (a machine's folder is never resolved)
 */
export function folderPrefsPatch(
  groups: ProjectGroupData[],
  prefs: { sidebarFolders?: string[]; sidebarProjectOrder?: string[]; pinnedProjects?: string[]; hiddenFolders?: string[] },
  resolve: (path: string) => string,
  machineKeyOf: (key: string) => string = machineProjectKey,
): { sidebarFolders: string[]; sidebarProjectOrder: string[] } | null {
  const known = prefs.sidebarFolders ?? [];
  const here = (a: string, b: string) => samePath(resolve(a), resolve(b));
  const onMachine = (g: ProjectGroupData, path: string) => {
    if (!g.machine) return false;
    const folded = machineProjectPath(path);
    return [...(g.machineFolders ?? [g.path])].some((raw) => raw === path || (g.path === folded && machineProjectPath(raw) === folded));
  };
  // a bare path that is a machine's folder and no folder of this Mac's chats
  const legacy = (p: string) =>
    !machineFolderOf(p) &&
    !prefs.hiddenFolders?.includes(p) &&
    !prefs.pinnedProjects?.some((pin) => !machineFolderOf(pin) && here(pin, p)) &&
    groups.some((g) => onMachine(g, p)) &&
    !groups.some((g) => !g.machine && (g.saved || g.threads.length > 0) && here(g.path, p));
  // A folder may be a distinct checkout once the Host answers. Retain its original key and saved position.
  const kept = [
    ...new Set(
      known.flatMap((p) => (legacy(p) ? groups.filter((g) => onMachine(g, p)).map((g) => machineFolderKey(g.machine!.id, p)) : [p])),
    ),
  ];
  const rememberedKeys = new Set(kept.map((key) => machineKeyOf(key)));
  const remembered = (g: ProjectGroupData) => (g.machine ? rememberedKeys.has(folderEntryOf(g)) : kept.some((p) => here(p, g.path)));
  const added = groups.filter((g) => !g.saved && g.threads.length > 0 && !remembered(g)).map(folderEntryOf);
  const order = prefs.sidebarProjectOrder ?? [];
  const ordered = new Set(order.map((key) => machineKeyOf(key)));
  const keys = groups
    .filter((g) => g.saved || g.threads.length > 0 || remembered(g))
    .map(groupKey)
    .filter((key) => !ordered.has(key));
  const moved = kept.length !== known.length || kept.some((p, i) => p !== known[i]);
  if (!moved && !added.length && !keys.length) return null;
  return { sidebarFolders: [...kept, ...added], sidebarProjectOrder: [...order, ...keys] };
}
