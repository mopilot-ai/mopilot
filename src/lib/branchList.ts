// A folder's (this Mac's, or a machine's by its folder key) git branch list as a hook, and whether a managed worktree can start from that folder.

import { useState } from 'react';
import { useEffectOn } from './effects';
import { native, type BranchList } from './native';
import { machineBranches } from './machineBranches';
import { machineFolderOf } from './machineFolder';
import { worktreeUnsupported } from '../../shared/worktreeSupport.mjs';

/**
 * `path`'s branch list (`path`: a folder of this Mac, or a machine's by `machineFolderKey`) while `on`: undefined until it loads, null outside a repo or when listing fails. It is read again
 * when `reload` changes; an answer for another folder, or after the caller is gone, is dropped.
 */
export function useBranchList(path: string, on = true, reload: unknown = null): BranchList | null | undefined {
  const [loaded, setLoaded] = useState<{ path: string; list: BranchList | null } | null>(null);
  useEffectOn([path, on, reload], () => {
    if (!on) return;
    let live = true;
    // a folder on a machine is read through its Host, never on this Mac (its key names both)
    const there = machineFolderOf(path);
    (there ? machineBranches(there.machineId, there.path) : native.git.branches(path)).then(
      (list) => live && setLoaded({ path, list }),
      () => live && setLoaded({ path, list: null }),
    );
    return () => {
      live = false;
    };
  });
  return on && loaded?.path === path ? loaded.list : undefined;
}

/**
 * Why no worktree can start from `path` (worktreeUnsupported's reason; not a repo also when git can't list it), null
 * when one can, or undefined while that isn't known: before it loads, without a folder, or while not `on`.
 */
export function useWorktreeSupport(path: string | null, on: boolean): string | null | undefined {
  const list = useBranchList(path ?? '', on && !!path);
  return list === undefined ? undefined : worktreeUnsupported(list);
}
