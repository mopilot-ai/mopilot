// Project activity ranking shared by the sidebar and Projects page, with per-sort aggregate caching.
import { activityAt, type Active } from './chatActivity';
import { machineFolderKey } from './machineFolder';
interface ProjectActivity {
  threads: readonly Active[];
  starting?: readonly Active[];
  cloudTasks?: readonly { updated_at?: string | number }[];
}

interface OrderedProject extends ProjectActivity {
  id: string | null;
  repositoryKey?: string;
  repository?: string;
  machineGroups?: readonly string[];
  path: string;
  name: string;
  /** the machine a folder group's folder is on; none for a folder on this Mac */
  machine?: { id: string };
}

/** The key a group is ordered, pinned, folded and remembered by: its project's id, else its folder. A folder on a machine carries the machine, so the same path on two machines (or on this Mac) is two groups. */
export const groupKey = (g: Pick<OrderedProject, 'id' | 'path' | 'machine' | 'repositoryKey'>): string =>
  g.repositoryKey ?? g.id ?? machineFolderKey(g.machine?.id ?? '', g.path);

/** Unranked discovered groups need a fallback unrelated to the order their chats arrived in. */
export const compareProjectKeys = (a: string, b: string) => Number(a > b) - Number(a < b);

/** The newest activity, including manually reordered chats; no variadic argument limit. */
export function projectRecency(group: ProjectActivity): number {
  let last = 0;
  for (const thread of group.threads) last = Math.max(last, activityAt(thread));
  for (const entry of group.starting ?? []) last = Math.max(last, activityAt(entry));
  for (const task of group.cloudTasks ?? []) last = Math.max(last, cloudActivity(task));
  return last;
}

export function cloudActivity(task: { updated_at?: string | number }) {
  const timestamp = task.updated_at;
  if (typeof timestamp === 'number') return Number.isFinite(timestamp) ? (timestamp > 1e12 ? timestamp / 1000 : timestamp) : 0;
  return typeof timestamp === 'string' ? Date.parse(timestamp) / 1000 || 0 : 0;
}

/** Sort only the group array. Ties keep input order, and no derived value outlives this call. */
export function sortProjectGroups<T extends OrderedProject>(groups: T[], order: string[], pinned: string[], sort: string): T[] {
  const rank = new Map(order.map((key, i) => [key, i]));
  const pins = new Set(pinned);
  const recency = new Map<T, number>();
  const last = (group: T) => {
    let value = recency.get(group);
    if (value === undefined) {
      value = projectRecency(group);
      recency.set(group, value);
    }
    return value;
  };
  const orderOf = (group: T) => {
    const own = rank.get(groupKey(group)) ?? (group.repository ? rank.get(`repo:${group.repository}`) : undefined);
    if (own !== undefined) return own;
    return (group.machineGroups ?? []).reduce((first, key) => Math.min(first, rank.get(key) ?? order.length), order.length);
  };
  return groups.sort((a, b) => {
    const pinned = Number(pins.has(groupKey(b))) - Number(pins.has(groupKey(a)));
    if (pinned) return pinned;
    if (sort === 'updated') return last(b) - last(a);
    if (sort === 'name') return a.name.localeCompare(b.name);
    // Discovering older history must not promote its previously unseen project above the user's order.
    const placement = orderOf(a) - orderOf(b);
    return placement || compareProjectKeys(a.repositoryKey ?? '', b.repositoryKey ?? '');
  });
}
