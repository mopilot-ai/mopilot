// A folder on a machine as the new-chat controls' source of branches: the list the branch picker shows, the switch to a picked branch and a worktree made there, all through the machine's Host (the local source is window.native.git; src/lib/branchList.ts picks one by the folder's key).
import { attemptKey, folderNotice, unwrap } from './hostFolders';
import { native, type BranchList } from './native';
import type { HostReply } from './native/host';

/** A machine folder's branches as this Mac's picker has them, with the repository's top folder and the folder's place in it ('' at the top). */
export type MachineBranchList = BranchList & { top: string; sub: string };

/** A Host call's answer, or an Error that says the refusal in words (`folderNotice`) and keeps its `code`. */
async function said<T>(call: Promise<HostReply<T>>): Promise<T> {
  try {
    return await unwrap(call);
  } catch (e) {
    throw Object.assign(new Error(folderNotice(e)), { code: (e as { code?: unknown }).code });
  }
}

/** `path`'s branches on the machine; null for a folder that is no repository. Rejects with the Host's refusal (`code`), `host_outdated` for a Host from before it. */
export async function machineBranches(machineId: string, path: string, expectedHostKey?: string): Promise<MachineBranchList | null> {
  const r = await said(native.host.gitBranches(machineId, { path, ...(expectedHostKey !== undefined && { expectedHostKey }) }));
  return r.isRepo ? { current: r.current, default: r.default, branches: r.branches, commits: r.commits, top: r.top, sub: r.sub } : null;
}

/** Checks out `branch` in `path` on the machine, where a chat runs without a worktree; rejects with the sentence for the person (git's, or the Host's). */
export async function machineSwitchBranch(machineId: string, path: string, branch: string, expectedHostKey?: string): Promise<void> {
  const r = await said(native.host.gitSwitch(machineId, { path, branch, ...(expectedHostKey !== undefined && { expectedHostKey }) }));
  if (!r.ok) throw new Error(r.refused ? r.stderr : r.stderr.split('\n')[0] || `Failed to switch to "${branch}"`);
}

/**
 * A worktree of the repository `list` came from, on a new branch `branch` that starts from `from` (the Host's HEAD when null); the folder a chat runs in is the worktree's, with the folder's own place in the repository kept.
 * Rejects with the Host's refusal in words.
 */
export async function machineWorktree(
  machineId: string,
  list: MachineBranchList,
  branch: string,
  from: string | null,
  expectedHostKey?: string,
): Promise<string> {
  const query = {
    key: attemptKey(),
    repo: list.top,
    branch,
    ...(from ? { from } : {}),
    ...(expectedHostKey !== undefined && { expectedHostKey }),
  };
  const place = await said(native.host.worktree(machineId, query));
  return list.sub ? `${place.path.replace(/\/+$/, '')}/${list.sub}` : place.path;
}
