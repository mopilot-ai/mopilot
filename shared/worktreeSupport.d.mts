export const NOT_A_REPO: string;
export const NO_COMMITS: string;

/** Why no worktree can start from the folder whose branch list this is (null: outside a repo), or null when one can. */
export function worktreeUnsupported(list: { commits?: boolean } | null | undefined): string | null;
