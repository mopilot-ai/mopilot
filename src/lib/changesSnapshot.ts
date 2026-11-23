// What the Changes pane holds of its last read: the files, or the sentence that stands in for them, kept for the context (folder, scope, source) it was read in.
import type { ChangesRead } from './changesSource';
import { reuseDiffFiles, type DiffFile } from './diff';

/** What the pane says for a folder that isn't in a git repository: not an error, there is just nothing to diff. */
export const NOT_A_REPOSITORY = 'This folder is not a git repository';

export type ChangesSnapshot = {
  context: object;
  root: string;
  files: DiffFile[];
  error: string | null;
  notice?: { text: string; hostId?: string };
  cut?: string;
  /** the paths in conflict (relative to the folder) */
  conflicted: readonly string[];
};

/** A file in conflict whose patch has no lines (deleted on both sides) still gets its row, so the pane shows what Commit waits for. */
function withConflictRows(files: DiffFile[], conflicted: readonly string[]): DiffFile[] {
  const listed = new Set(files.map((f) => f.path));
  const missing = conflicted.filter((path) => !listed.has(path));
  return missing.length ? [...files, ...missing.map((path) => ({ path, lines: [], added: 0, removed: 0 }))] : files;
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((p, i) => p === b[i]);

/** The snapshot a read makes; a read of the same diff as `previous` gives `previous` back, so the pane is not rendered (and colored) again. */
export function snapshotOf(previous: ChangesSnapshot | null, context: object, cwd: string, read: ChangesRead): ChangesSnapshot {
  if (read.kind === 'notRepo') return { context, root: cwd, files: [], error: NOT_A_REPOSITORY, conflicted: [] };
  if (read.kind === 'notice') return { context, root: cwd, files: [], error: null, notice: read, conflicted: [] };
  const { conflicted } = read;
  const incoming = withConflictRows(read.files, conflicted);
  const alike =
    previous?.context === context &&
    previous.root === read.root &&
    previous.error === null &&
    !previous.notice &&
    previous.cut === read.cut &&
    same(previous.conflicted, conflicted);
  const kept = alike ? reuseDiffFiles(previous.files, incoming) : incoming;
  return alike && kept === previous.files ? previous : { context, root: read.root, files: kept, error: null, cut: read.cut, conflicted };
}
