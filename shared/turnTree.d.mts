export type Git = (cwd: string, args: string[], env?: Record<string, string>) => Promise<string>;
export type TreeDeps = {
  git: Git;
  env: () => Record<string, string>;
  fs: typeof import('node:fs').promises;
  tmpdir: () => string;
  ignored?: (what: string, error: unknown) => void;
  skipUntracked?: { file: number; total: number; leave?: readonly string[]; onSkipped?: (names: string[]) => void };
};
export type Head = { id: string; log: number } | null;
export function snapshotTree(deps: TreeDeps, cwd: string): Promise<string>;
export function headOf(git: Git, cwd: string): Promise<Head>;
export function compareTrees(
  git: Git,
  cwd: string,
  before: string,
  after: string,
  heads?: { before: Head; after: { id: string } | null },
  maxBytes?: number,
  leave?: readonly string[],
): Promise<string>;
