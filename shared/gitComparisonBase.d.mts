// Types for the read-only Git branch comparison shared by local and remote readers.
export const BRANCH_COMPARISON_GIT_ENV: Readonly<{ GIT_NO_LAZY_FETCH: '1'; GIT_ALLOW_PROTOCOL: '' }>;
export const BRANCH_BASE_UNAVAILABLE: string;
export function branchComparisonBase(
  git: (args: string[]) => Promise<{ ok: boolean; stdout: string; code?: number | string; cut?: boolean }>,
): Promise<string | null>;
