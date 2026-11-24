// Sidebar repository identity for the Host's <repo>.worktrees/<escaped-branch> folders; execution keeps the original cwd.
import { foldHostWorktreePath as machineProjectPath } from '../../shared/paths.mjs';
import { machineFolderKey, machineFolderOf } from './machineFolder';

export { machineProjectPath };

/** Saved machine-folder aliases use the same group; local paths and saved project ids retain their identity. */
export function machineProjectKey(
  key: string,
  pathOf: (machine: string, folder: string) => string = (_, path) => machineProjectPath(path),
) {
  const remote = machineFolderOf(key);
  return remote ? machineFolderKey(remote.machineId, pathOf(remote.machineId, remote.path)) : key;
}

/** A repository's explicit chat order wins, followed by orders saved for its former worktree groups. */
export function machineProjectChatOrder(
  orders: Record<string, string[]>,
  key: string,
  keyOf: (alias: string) => string = machineProjectKey,
) {
  return [
    ...new Set([
      ...(orders[key] ?? []),
      ...Object.entries(orders)
        .filter(([alias]) => alias !== key && keyOf(alias) === key)
        .flatMap(([, ids]) => ids),
    ]),
  ];
}

/** The repository's own expand/collapse choice wins; otherwise retain an explicit collapse from its former groups. */
export function machineProjectCollapsed(
  collapsed: Record<string, boolean>,
  key: string,
  keyOf: (alias: string) => string = machineProjectKey,
) {
  return collapsed[key] ?? Object.entries(collapsed).some(([alias, value]) => value && keyOf(alias) === key);
}
