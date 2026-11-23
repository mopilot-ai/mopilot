// The branch of a new chat's folder through the Host (#5099): the feature both ends declare, the branch list read, the switch write and their parsers; `git.worktree`'s `from` (the branch a worktree starts from) is gated on the same feature. An older Host answers `Unknown method` or `feature_missing`, and the app says to update it.

/** Declared by a Host that serves the branch list, the switch and a worktree's start branch; an end without it is never sent one. */
export const GIT_BRANCH_FEATURE = 'gitBranch';
export const GIT_BRANCHES_METHOD = 'host.gitBranches';
export const GIT_SWITCH_METHOD = 'host.gitSwitch';

/** A branch name a request may carry: text git could take as a name, never an option. @param {unknown} v @param {(m: string) => Error} bad */
export function branchNameOf(v, bad) {
  if (typeof v !== 'string' || !v || v.length > 255 || /[\s\u0000-\u001f]/.test(v) || v.startsWith('-')) throw bad('Pick a branch name.');
  return v;
}

/** @param {(v: unknown, what: string) => string} pathOf schema.mjs's absolute-path check @param {(m: string) => Error} bad */
export const gitBranchParsers = (pathOf, bad) => ({
  [GIT_BRANCHES_METHOD]: (/** @type {any} */ p) => ({ path: pathOf(p.path, 'a folder') }),
  [GIT_SWITCH_METHOD]: (/** @type {any} */ p) => ({ path: pathOf(p.path, 'a folder'), branch: branchNameOf(p.branch, bad) }),
});

/** `git.worktree`'s parser: the repository, the new branch and, when the app names one, the branch it starts from. @param {(p: any) => string} keyOf @param {(v: unknown, what: string) => string} pathOf @param {(v: unknown) => string} branchOf */
export const worktreeParser = (keyOf, pathOf, branchOf) => (/** @type {any} */ p) => ({
  key: keyOf(p),
  repo: pathOf(p.repo, 'a repository'),
  branch: branchOf(p.branch),
  ...(p.from == null ? {} : { from: branchOf(p.from) }),
});

/** The feature a worktree request needs beyond its method's: a start branch an older Host would drop is a worktree made from the wrong commit, so such a Host is refused. @param {string} method @param {any} params */
export const worktreeNeeds = (method, params) => (method === 'git.worktree' && params?.from != null ? [GIT_BRANCH_FEATURE] : []);
