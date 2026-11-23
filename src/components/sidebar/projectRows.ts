// Common sort, identity and shared Host location for chat and cloud-task entries in sidebar lists.
import { activityAt } from '../../lib/chatActivity';
import { cloudActivity } from '../../lib/projectGroupOrder';
import type { CloudTask } from '../../lib/native';
import type { Thread } from '../../store/types';
import type { ProjectGroupData } from './projectGroups';

/** The session owners include those behind Show more and in folded families. */
export function projectSessionLocations(
  group: ProjectGroupData,
  ownerOf: (chatId: string) => string | null,
  descendants: ReadonlyMap<string, readonly string[]>,
) {
  const owners = new Set<string | null | undefined>(group.starting?.map((entry) => entry.hostId));
  for (const { id } of group.threads) {
    owners.add(ownerOf(id));
    // Placement adds family roots, all of which have an entry in the family index.
    for (const child of descendants.get(id)!) owners.add(ownerOf(child));
  }
  const [id] = owners;
  return {
    shared: !group.cloudTasks?.length && owners.size === 1 && id ? id : undefined,
    hosts: [...owners].filter((owner): owner is string => !!owner),
  };
}

export function projectRows(threads: readonly Thread[], tasks: readonly CloudTask[] = []) {
  return [
    ...threads.map((thread) => ({ key: thread.id, activity: activityAt(thread), kind: 'chat' as const, thread })),
    ...tasks.map((task) => ({ key: `cloud:${task.id}`, activity: cloudActivity(task), kind: 'cloud' as const, task })),
  ];
}

export function sortProjectRows<T extends { key: string; activity: number }>(rows: T[], order?: readonly string[]) {
  const ranks = new Map(order?.map((id, index) => [id, index]));
  return rows.sort((a, b) => (order ? (ranks.get(a.key) ?? -1) - (ranks.get(b.key) ?? -1) : b.activity - a.activity));
}

/** Merge task activity into the chat order the sidebar already assigned. */
export function mergeProjectRows<T extends { kind: 'chat' | 'cloud'; activity: number }>(rows: T[]): T[] {
  const tasks = rows.filter((row) => row.kind === 'cloud').sort((a, b) => b.activity - a.activity);
  if (!tasks.length) return rows;
  const result: T[] = [];
  let index = 0;
  for (const row of rows) {
    if (row.kind === 'cloud') continue;
    while (index < tasks.length && tasks[index].activity > row.activity) result.push(tasks[index++]);
    result.push(row);
  }
  return [...result, ...tasks.slice(index)];
}
