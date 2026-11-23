// Types for the shared index-aware discard.
export type Result = { ok: boolean; stdout: string; stderr: string; code?: number | string };
export type Git = { run(cwd: string, args: string[]): Promise<Result> };
export function restoreFromRoot(git: Git, cwd: string, paths: string[], folder?: boolean): Promise<Result>;
export function discardGitFile(git: Git, cwd: string, path: string): Promise<Result>;
export function discardGitChanges(git: Git, cwd: string, scope?: string): Promise<Result>;
