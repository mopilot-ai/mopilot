// The Changes pane's commit and discard on a machine, through its Host (#5050): the same results this Mac's git gives the pane (a refusal is words in `stderr`, `refused`), so the one pane code reads both.
import { folderNotice } from './hostFolders';
import { native } from './native';
import type { HostReply, HostWriteResult } from './native/host';

type CommitFile = { path: string; oldPath?: string; isCopy?: boolean; isDeleted?: boolean };

/** A Host's answer as the pane's own result: a refusal (outside the roots, an older Host, no audit record) is a sentence the pane shows as it is. */
const result = ({ value, error }: HostReply<HostWriteResult>): HostWriteResult & { stdout: string } =>
  error ? { ok: false, stdout: '', stderr: folderNotice(error), refused: true } : { stdout: '', ...value };

/** Commit every change in `path` on the machine (`files` null) or only those files (relative to it). */
export async function hostCommit(machineId: string, path: string, message: string, files: CommitFile[] | null) {
  return result(await native.host.gitCommit(machineId, { path, message, files }));
}

/** Discard the changes of `file` (relative to `path` on the machine), or of every file in it (`file` null). */
export async function hostDiscard(machineId: string, path: string, file: string | null) {
  return result(await native.host.gitDiscard(machineId, { path, file }));
}

/** What a failed discard says: the Host's own sentence for a refusal, else git's first line, as this Mac's pane words it. */
export const discardFailure = (result: { stderr: string; refused?: true }): string =>
  result.refused ? result.stderr : result.stderr.split('\n')[0] || 'Could not discard changes';
