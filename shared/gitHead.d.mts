// Types for shared unborn Git HEAD detection.
type GitResult = { ok: boolean; stdout: string; code?: number | string };
export function isUnbornHead(run: (args: string[]) => Promise<GitResult>): Promise<boolean>;
