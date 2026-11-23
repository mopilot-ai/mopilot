// The Changes pane's commit box and per-file ticks: a message and the files left out of the next commit, kept per repository while the pane is open, and the commit itself (every change, or only the ticked files).
import { useRef, useState } from 'react';
import { commitFailure } from '../../lib/commitFiles';
import { busyField, isEnter } from '../../lib/focus';
import { errorText } from '../../lib/ignored';
import { toast } from '../../store/core';
import { conflictsSentence } from '../../../shared/gitUnmerged.mjs';
import type { DiffFile } from '../diff/DiffView';
import { GitCommitHorizontal } from '../ui/icons';

/** A file the commit names, as the diff lists it. */
export type CommitFile = { path: string; oldPath?: string; isCopy?: boolean; isDeleted?: boolean };
/** Commits every change (`files` null) or only those files: this Mac's git, or a machine's Host. */
export type RunCommit = (
  message: string,
  files: CommitFile[] | null,
) => Promise<{ ok: boolean; stdout: string; stderr: string; refused?: true; warning?: string }>;

/** One repository's draft: its message, and the paths the user unticked (every other file, a new one too, goes in). */
type Draft = { message: string; left: ReadonlySet<string> };
const NO_FILES: readonly string[] = [];
const EMPTY: Draft = { message: '', left: new Set() };

export type CommitDraft = {
  message: string;
  /** some file was unticked (listed now or not): the commit names its files, never takes every change */
  anyLeft: boolean;
  setMessage: (message: string) => void;
  included: (path: string) => boolean;
  toggle: (path: string) => void;
};

/** The commit draft of the repository at `root`, kept for each repository the pane has shown. */
export function useCommitDraft(root: string): CommitDraft {
  const [drafts, setDrafts] = useState(() => new Map<string, Draft>());
  const draft = drafts.get(root) ?? EMPTY;
  const update = (change: (d: Draft) => Draft) => setDrafts((all) => new Map(all).set(root, change(all.get(root) ?? EMPTY)));
  return {
    message: draft.message,
    anyLeft: draft.left.size > 0,
    setMessage: (message) => update((d) => ({ ...d, message })),
    included: (path) => !draft.left.has(path),
    toggle: (path) =>
      update((d) => {
        const left = new Set(d.left);
        if (!left.delete(path)) left.add(path);
        return { ...d, left };
      }),
  };
}

/** A file's tick in the file list: whether the next commit takes it. */
export function CommitPick({ draft, path, conflicted = false }: { draft: CommitDraft; path: string; conflicted?: boolean }) {
  return (
    <input
      type="checkbox"
      className="cp-file-pick"
      checked={!conflicted && draft.included(path)}
      disabled={conflicted}
      title={conflicted ? 'Resolve this conflict before committing it' : undefined}
      onChange={() => draft.toggle(path)}
      aria-label={`Include ${path} in the commit`}
    />
  );
}

/**
 * The message field and Commit button under the file list. With some files unticked the button says how many it
 * commits, and the rest stay uncommitted as they are. `live` says whether the pane still shows this repository when
 * git answers; `done` reads it again.
 */
export function CommitBox({
  commit: runCommit,
  files,
  draft,
  conflicted = NO_FILES,
  live,
  done,
}: {
  commit: RunCommit;
  files: DiffFile[];
  draft: CommitDraft;
  /** the paths in conflict: git commits none while one is, so none is ticked or counted, and Commit waits and says so */
  conflicted?: readonly string[];
  live: () => boolean;
  done: () => void;
}) {
  const [committing, setCommitting] = useState(false);
  const pending = useRef(false);
  // a path listed twice (a file turned into a link: its deletion and its addition) is one file, with one tick
  const conflicts = conflicted.length;
  const commitable = files.filter((f) => !conflicted.includes(f.path));
  const listed = [...new Map(commitable.map((f) => [f.path, f])).values()];
  const picked = commitable.filter((f) => draft.included(f.path));
  const count = new Set(picked.map((f) => f.path)).size;
  // an unticked file no longer listed (reverted since) still keeps the commit to the ticked files
  const some = count < listed.length || draft.anyLeft;
  const commit = async () => {
    if (pending.current || !draft.message.trim()) return;
    if (conflicts > 0) return void toast(`${conflictsSentence(conflicts)}.`, 'error');
    if (!count) return;
    pending.current = true;
    setCommitting(true);
    try {
      const result = await runCommit(
        draft.message,
        some ? picked.map(({ path, oldPath, isCopy, isDeleted }) => ({ path, oldPath, isCopy, isDeleted })) : null,
      );
      if (!live()) return;
      if (result.ok) {
        if (result.warning) toast(result.warning, 'info');
        else toast(some ? `Committed ${count === 1 ? '1 file' : `${count} files`}` : 'Committed changes', 'success');
        draft.setMessage('');
      } else toast(commitFailure(result), 'error');
    } catch (error) {
      if (live()) toast(errorText(error), 'error');
    } finally {
      pending.current = false;
      setCommitting(false);
      done();
    }
  };
  return (
    <div className="cp-commit">
      <input
        className="text-input"
        placeholder="Commit message"
        value={draft.message}
        {...busyField(committing)}
        onChange={(e) => draft.setMessage(e.target.value)}
        onKeyDown={(e) => isEnter(e) && commit()}
      />
      <button
        className="btn primary sm"
        disabled={committing || !draft.message.trim() || !count || conflicts > 0}
        title={conflicts > 0 ? conflictsSentence(conflicts) : undefined}
        onClick={commit}
      >
        <GitCommitHorizontal size={14} /> {some ? `Commit ${count} of ${listed.length}` : 'Commit'}
      </button>
    </div>
  );
}
