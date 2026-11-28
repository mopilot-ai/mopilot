// Project sidebar projection that joins verified Codex Cloud tasks to their repository; machine folders keep their own groups.
import { environmentRepository } from '../../../shared/sidebarRepository.mjs';
import type { CloudTask, CloudEnv } from '../../lib/native';
import { groupKey } from '../../lib/projectGroupOrder';
import type { ProjectGroupData } from './projectGroups';

export function groupRepositories(
  sources: ProjectGroupData[],
  listed: ReadonlySet<string>,
  repositoryOf: (group: ProjectGroupData) => string | undefined,
  tasks: readonly CloudTask[],
  environments: readonly CloudEnv[],
  hidden: readonly string[],
  homeKey: string | null,
  pinned: readonly string[] = [],
  unplacedTasks: readonly string[] = [],
) {
  const groups = sources.map((group) => ({
    ...group,
    threads: [...group.threads],
    starting: group.starting && [...group.starting],
    pinnedKeys: group.pinnedKeys && [...group.pinnedKeys],
  }));
  const candidates = new Map<string, ProjectGroupData[]>();
  const remote = new Map<string, ProjectGroupData>();
  const visible = new Set(listed);
  const pins = new Set(pinned);
  const cloud: CloudTask[] = [];
  for (const group of groups) {
    const repo = repositoryOf(group);
    if (!repo || group.machine || hidden.includes(group.path)) continue;
    group.repository = repo;
    const matches = candidates.get(repo);
    if (matches) matches.push(group);
    else candidates.set(repo, [group]);
  }
  function destination(repo: string) {
    const key = `repo:${repo}`;
    if (hidden.includes(key)) return null;
    const matches = candidates.get(repo) ?? [];
    if (matches.length === 1) return matches[0];
    let group = remote.get(repo);
    if (!group) {
      const [, ...parts] = repo.split('/');
      group = {
        id: null,
        repositoryKey: key,
        repository: repo,
        name: repo.slice(repo.lastIndexOf('/') + 1),
        hint: parts.slice(0, -1).join('/'),
        path: '',
        threads: [],
        saved: false,
      };
      remote.set(repo, group);
    }
    return group;
  }
  // As in Claude Code, a session on a machine stays in the group of the folder it runs in on that machine: a local project of
  // the same repository is a different folder, so its row never takes the machine's sessions.
  const byEnvironment = new Map<string, { env: CloudEnv; repo: string }>();
  const addEnvironment = (group: ProjectGroupData, env: CloudEnv) => {
    if (!group.locations?.some((location) => location.kind === 'cloud' && location.id === env.id))
      group.locations = [...(group.locations ?? []), { kind: 'cloud', id: env.id, label: env.label }];
  };
  for (const env of environments) {
    if (!env || typeof env.id !== 'string' || typeof env.label !== 'string') continue;
    const repo = environmentRepository(env);
    if (repo) byEnvironment.set(env.id, { env, repo });
  }
  const unplaced = new Set(unplacedTasks);
  for (const task of tasks) {
    const location = task.environment_id && !unplaced.has(task.id) ? byEnvironment.get(task.environment_id) : undefined;
    const target = location ? destination(location.repo) : null;
    if (!target || !location) {
      cloud.push(task);
      continue;
    }
    (target.cloudTasks ??= []).push(task);
    visible.add(groupKey(target));
  }
  for (const { env, repo } of byEnvironment.values()) {
    const matches = candidates.get(repo) ?? [];
    const key = `repo:${repo}`;
    const target = matches.length === 1 ? destination(repo) : (remote.get(repo) ?? (pins.has(key) ? destination(repo) : null));
    if (target) addEnvironment(target, env);
  }
  const projected = [...groups, ...remote.values()];
  for (const group of projected) {
    if (!group.repository || !group.locations?.length) continue;
    const key = `repo:${group.repository}`;
    if (pins.has(key)) {
      group.pinnedKeys = [...new Set([...(group.pinnedKeys ?? []), key])];
      visible.add(groupKey(group));
    }
  }
  return { groups: projected, listed: projected.filter((group) => visible.has(groupKey(group))), cloud, homeKey };
}
