// The Changes pane's source seam: where a folder's changes are read from and where its commit and discard go (this Mac's git, or a machine's Host), and what each source can honestly offer the pane.
import type { DiffFile } from './diff';
import { discardGitChanges, discardGitFile } from './gitDiscard';
import { machineFolderKey } from './machineFolder';
import { native } from './native';
import { absPath } from './paths';
import { repositoryDiffFiles } from './repositoryChanges';

/** The scopes a source reads; the pane's Last Turn comes from the chat's own turns, not from a source. */
export type ChangesReadScope = 'uncommitted' | 'branch';

/** What a source answers for a folder. `cut` is a sentence the pane shows under the files (the source cut the patch); `conflicted` the paths (relative to the folder) git lists as unmerged (an older Host does not say: none); a `notice` is a sentence the pane shows in place of them. */
export type ChangesRead =
  | { kind: 'files'; root: string; files: DiffFile[]; cut?: string; conflicted: string[] }
  | { kind: 'notRepo' }
  | { kind: 'notice'; text: string; hostId?: string };

/** A file a commit names, as the diff lists it. */
export type ChangesCommitFile = { path: string; oldPath?: string; isCopy?: boolean; isDeleted?: boolean };

/** What a commit or discard answers: git's own result on this Mac, the same shape from a Host (a refusal is words in `stderr`, with `refused`). */
export type ChangesWriteResult = { ok: boolean; stdout: string; stderr: string; refused?: true; warning?: string };

/** A control the source offers, or the reason it does not (written once, by the source, and shown where the control would be). */
export type Capability = { on: true } | { on: false; reason: string };

export type ChangesCapabilities = {
  /** the Last Turn scope (the chat's turn diff) */
  lastTurn: Capability;
  /** Open in the editor: needs a copy of the file on this Mac */
  openInEditor: Capability;
  /** Reveal in Finder: needs a copy of the file on this Mac */
  reveal: Capability;
  /** Attach as context: attaches the file's path on this Mac */
  attach: Capability;
  /** line and hunk comments, pull request review threads and the findings walk: they go by a folder on this Mac */
  comments: Capability;
  /** reading again on a timer; off, the pane reads on open, on a turn change, on focus, on Refresh and after a write */
  poll: Capability;
};

export interface ChangesSource {
  /** which folder the pane shows: a read, write or answer made for another source's key is no longer wanted */
  key: string;
  /** appended to the questions the pane asks before a discard (" on box"), '' on this Mac */
  where: string;
  /** the key of the repository at `root` for what the pane remembers (Viewed marks, the commit draft): `root` on this Mac, the machine's id and `root` on a machine */
  keyOf(root: string): string;
  /** the path a file is copied or attached by */
  pathOf(file: string, root: string): string;
  /** reads `scope` fresh or from the cache; null when `live()` says the pane moved on while the source was reading */
  read(scope: ChangesReadScope, fresh: boolean, live: () => boolean): Promise<ChangesRead | null>;
  /** the files the chat's last turn changed (`turnIds`, newest first: the first turn that changed any), when the source reads them itself; absent: the pane takes them from the chat's own turns */
  readTurn?(turnIds: string[], live: () => boolean): Promise<ChangesRead | null>;
  /** commits every change (`files` null) or the named files, in the repository at `root` */
  commit(root: string, message: string, files: ChangesCommitFile[] | null): Promise<ChangesWriteResult>;
  /** discards the changes of `file` (relative to `root`), or all of them (`file` null) */
  discard(root: string, file: string | null): Promise<ChangesWriteResult>;
  /** the sentence a failed discard of `file` (null: all) says */
  discardFailure(file: string | null, result: ChangesWriteResult): string;
  capabilities: ChangesCapabilities;
}

const ON: Capability = { on: true };

/** This Mac's folder: its git, its files, every control. */
export function localChangesSource(cwd: string): ChangesSource {
  return {
    key: cwd,
    where: '',
    keyOf: (root) => machineFolderKey('', root),
    pathOf: absPath,
    read: async (scope, fresh, live) => {
      const repository = await native.git.info(cwd);
      if (!live()) return null;
      if (!repository?.root) return { kind: 'notRepo' };
      const files = await repositoryDiffFiles(native.git, repository.root, scope, fresh);
      // a conflict is what a commit would refuse on: the pane marks those files (the uncommitted scope is the one that commits)
      const status = scope === 'uncommitted' ? await native.git.status(repository.root, fresh) : null;
      return {
        kind: 'files',
        root: repository.root,
        files,
        conflicted: (status?.files ?? []).filter((f) => f.conflicted).map((f) => f.path),
      };
    },
    commit: (root, message, files) => native.git.commitFiles(root, message, files),
    discard: (root, file) => (file === null ? discardGitChanges(native.git, root) : discardGitFile(native.git, root, file)),
    discardFailure: (file, result) =>
      result.stderr.split('\n')[0] || (file === null ? 'Could not discard changes' : 'Could not discard file changes'),
    capabilities: { lastTurn: ON, openInEditor: ON, reveal: ON, attach: ON, comments: ON, poll: ON },
  };
}
