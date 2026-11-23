// Whether a folder can hold a managed worktree and why not, worded the same by main's git platform and the new-chat switch.

export const NOT_A_REPO = "This folder isn't a git repository";
export const NO_COMMITS = 'This repository has no commits yet';

/**
 * Why no worktree can start from the folder whose branch list this is (null: outside a repo), or null when one can.
 * A list that doesn't say whether it has commits is taken to have them.
 */
export function worktreeUnsupported(list) {
  if (!list) return NOT_A_REPO;
  return list.commits === false ? NO_COMMITS : null;
}
