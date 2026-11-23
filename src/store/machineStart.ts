// Where a new chat on a machine starts: the draft's Worktree switch and branch pick carried out on the machine through its Host, as a chat in a folder of this Mac starts in its worktree or on its branch (src/store/chatCreation.ts).
import type { AppState } from './state';
import { machineFolderKey } from '../lib/machineFolder';
import { machineBranches, machineSwitchBranch, machineWorktree } from '../lib/machineBranches';
import { worktreeUnsupported } from '../../shared/worktreeSupport.mjs';
import { DEFAULT_BRANCH_PREFIX } from '../../shared/branchPrefix.mjs';
import { newChatWorktreeOn } from './chats';
import { get, toast } from './core';
import { chooseRepositoryLocation } from './repositoryDraft';

/**
 * The folder on the machine the new chat runs in. With the draft's Worktree switch on, a worktree of the repository on a new branch that starts from the picked branch (else origin's default, as the chip shows it); without it, the folder itself,
 * switched to the picked branch. A folder that is no repository (or has no commit to start from) runs the chat as it is, as on this Mac. Rejects with the sentence for the person (a branch the folder's changes would collide with, a worktree the machine refused).
 */
export async function machineStartFolder(host: { id: string; name: string; path: string }, s: AppState, scope?: string): Promise<string> {
  const pick = s.newChatBranch?.path === machineFolderKey(host.id, host.path) ? s.newChatBranch : null;
  const picked = pick?.branch ?? null;
  const wanted = newChatWorktreeOn(s);
  if (!wanted && !picked) return host.path;
  let list;
  try {
    list = await machineBranches(host.id, host.path, scope);
  } catch (e) {
    // the saved Worktree default asked for one, and a Host from before the branch calls cannot make it: the chat starts in the folder, and it is said
    if ((e as { code?: unknown }).code !== 'host_outdated') throw e;
    toast(`Update the Host on ${host.name} to start a chat in a worktree.`, 'info');
    return host.path;
  }
  if (scope !== undefined && get().newChatRepositoryGroup !== s.newChatRepositoryGroup) throw new Error(chooseRepositoryLocation);
  if (wanted && list && !worktreeUnsupported(list)) {
    const branch = `${s.prefs.branchPrefix || DEFAULT_BRANCH_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
    const path = await machineWorktree(host.id, list, branch, picked ?? list.default ?? list.current, scope);
    toast(`Working in worktree on ${branch}`);
    return path;
  }
  if (picked && list && picked !== list.current) await machineSwitchBranch(host.id, host.path, picked, scope);
  return host.path;
}
