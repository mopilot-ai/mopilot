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
  prefs: { sidebarFolders?: string[]; sidebarProjectOrder?: string[]; hiddenFolders?: string[] },
  resolve: (path: string) => string,
): { sidebarFolders: string[]; sidebarProjectOrder: string[] } | null {
  const known = prefs.sidebarFolders ?? [];
  const here = (a: string, b: string) => samePath(resolve(a), resolve(b));
  // a bare path that is a machine's folder and no folder of this Mac's chats
  const legacy = (p: string) =>
    !machineFolderOf(p) &&
    groups.some((g) => g.machine && g.path === machineProjectPath(p)) &&
    !groups.some((g) => !g.machine && g.threads.length > 0 && here(g.path, p));
  const kept = [
    ...new Set(
      known.flatMap((p) =>
        legacy(p)
          ? groups.filter((g) => g.machine && g.path === machineProjectPath(p)).map(folderEntryOf)
          : [prefs.hiddenFolders?.includes(p) ? p : machineProjectKey(p)],
      ),
    ),
  ];
  const remembered = (g: ProjectGroupData) => (g.machine ? kept.includes(folderEntryOf(g)) : kept.some((p) => here(p, g.path)));
  const added = groups.filter((g) => !g.saved && g.threads.length > 0 && !remembered(g)).map(folderEntryOf);
  const priorOrder = prefs.sidebarProjectOrder ?? [];
  const order = [...new Set(priorOrder.map(machineProjectKey))];
  const keys = groups
    .filter((g) => g.saved || g.threads.length > 0 || remembered(g))
    .map(groupKey)
    .filter((key) => !order.includes(key));
  const moved =
    kept.length !== known.length ||
    kept.some((p, i) => p !== known[i]) ||
    order.length !== priorOrder.length ||
    order.some((p, i) => p !== priorOrder[i]);
  if (!moved && !added.length && !keys.length) return null;
  return { sidebarFolders: [...kept, ...added], sidebarProjectOrder: [...order, ...keys] };
}
