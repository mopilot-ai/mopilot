// The Changes pane's git-based diffs: branch or uncommitted changes with explicit refreshes.
import { isUnbornHead } from '../../shared/gitHead.mjs';
import { parseUnifiedDiff, type DiffFile } from './diff';
import { GIT_DIFF_FLAGS } from '../../shared/gitDiffFlags.mjs';
import { BRANCH_BASE_UNAVAILABLE, branchComparisonBase } from '../../shared/gitComparisonBase.mjs';

type GitReader = {
  run(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; code?: number | string }>;
  diff(cwd: string, file?: string, fresh?: boolean): Promise<string>;
  status(cwd: string, fresh?: boolean): Promise<{ files: { code: string; path: string }[] } | null>;
};

/** Branch changes include committed work, pending edits, and untracked files. */
export async function repositoryDiffFiles(
  git: GitReader,
  cwd: string,
  scope: 'branch' | 'uncommitted',
  fresh = false,
): Promise<DiffFile[]> {
  if (!cwd) return [];
  if (scope === 'uncommitted') return parseUnifiedDiff(await git.diff(cwd, undefined, fresh));
  const run = (args: string[]) => git.run(cwd, ['--no-lazy-fetch', ...args]);
  const base = await branchComparisonBase(run);
  let result = base ? await run(['diff', base, ...GIT_DIFF_FLAGS]) : { ok: false, stdout: '', stderr: BRANCH_BASE_UNAVAILABLE };
  if (!result.ok && (base === null || base === 'HEAD')) {
    const head = await run(['rev-parse', '--verify', 'HEAD']);
    if (!head.ok) {
      if (await isUnbornHead(run)) {
        // Ask Git for the empty tree so SHA-1 and SHA-256 repositories both work.
        const empty = await run(['hash-object', '-w', '-t', 'tree', '--', '/dev/null']);
        if (!empty.ok || !empty.stdout.trim()) throw new Error(empty.stderr || 'Could not read empty repository tree');
        result = await run(['diff', empty.stdout.trim(), ...GIT_DIFF_FLAGS]);
      }
    }
  }
  if (!result.ok) throw new Error(result.stderr || 'Could not read branch changes');
  const files = parseUnifiedDiff(result.stdout);
  const status = await git.status(cwd, fresh);
  if (!status) throw new Error('Could not read repository status');
  for (const file of status.files) {
    if (file.code === '??') files.push(...parseUnifiedDiff(await git.diff(cwd, file.path, fresh)));
  }
  return files;
}
