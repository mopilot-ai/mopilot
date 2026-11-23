// Sidebar repository identity for the Host's <repo>.worktrees/<escaped-branch> folders; execution keeps the original cwd.
import { isAbsolutePath, isWinPath } from './paths';
import { machineFolderKey, machineFolderOf } from './machineFolder';

/** Fold a Host worktree, including its subfolders and nested worktrees, into its original repository without reading this Mac's disk. */
export function machineProjectPath(folder: string): string {
  if (!isAbsolutePath(folder)) return folder;
  const windows = isWinPath(folder);
  const parts = folder.split(windows ? /[\\/]/ : '/');
  const at = parts.findIndex(
    (part, i) =>
      i > 0 &&
      part.endsWith('.worktrees') &&
      part.length > 10 &&
      !!parts[i + 1] &&
      /^(?:[\w.-]|%[0-9a-f]{2,4})+$/i.test(parts[i + 1]) &&
      !['.', '..'].includes(parts[i + 1]),
  );
  if (at < 0) return folder;
  return [...parts.slice(0, at), parts[at].slice(0, -10)].join(windows && folder.includes('\\') ? '\\' : '/');
}

/** Saved machine-folder aliases use the same group; local paths and saved project ids retain their identity. */
export function machineProjectKey(key: string): string {
  const remote = machineFolderOf(key);
  return remote ? machineFolderKey(remote.machineId, machineProjectPath(remote.path)) : key;
}

/** A repository's explicit chat order wins, followed by orders saved for its former worktree groups. */
export function machineProjectChatOrder(orders: Record<string, string[]>, key: string): string[] {
  return [
    ...new Set([
      ...(orders[key] ?? []),
      ...Object.entries(orders)
        .filter(([alias]) => alias !== key && machineProjectKey(alias) === key)
        .flatMap(([, ids]) => ids),
    ]),
  ];
}

/** The repository's own expand/collapse choice wins; otherwise retain an explicit collapse from its former groups. */
export function machineProjectCollapsed(collapsed: Record<string, boolean>, key: string): boolean {
  return collapsed[key] ?? Object.entries(collapsed).some(([alias, value]) => value && machineProjectKey(alias) === key);
}
