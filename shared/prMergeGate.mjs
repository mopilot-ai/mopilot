// Whether a pull request can merge now, from the monitor's read of it: the one gate the merge button and main's merge share.

/** GitHub's merge states that mean nothing is in the way: every required check passed and no check is failing or running. */
const READY = new Set(['CLEAN', 'HAS_HOOKS']);

/**
 * What stops this pull request from merging, or null when it can merge. A failing or running check blocks even when
 * the repository does not require it: the read cannot tell a required check from an optional one, and a merge is not
 * undone.
 * @param {{ state?: string, mergeable?: string, mergeState?: string, failed?: number, pending?: number } | null | undefined} pr
 * @returns {{ reason: string, message: string } | null}
 */
export function mergeBlock(pr) {
  if (!pr) return { reason: 'unread', message: 'Checking the pull request…' };
  if (pr.state === 'MERGED') return { reason: 'merged', message: 'This pull request is already merged.' };
  if (pr.state !== 'OPEN') return { reason: 'closed', message: 'This pull request is closed.' };
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY')
    return { reason: 'conflicts', message: 'This pull request has merge conflicts. Resolve them first.' };
  if (pr.mergeState === 'DRAFT') return { reason: 'draft', message: 'This pull request is a draft. Mark it ready for review first.' };
  if (pr.failed) return { reason: 'checks_failing', message: `${pr.failed} ${pr.failed === 1 ? 'check is' : 'checks are'} failing.` };
  if (pr.pending)
    return { reason: 'checks_pending', message: `${pr.pending} ${pr.pending === 1 ? 'check is' : 'checks are'} still running.` };
  if (pr.mergeable === 'MERGEABLE' && READY.has(/** @type {string} */ (pr.mergeState))) return null;
  if (pr.mergeState === 'BEHIND') return { reason: 'behind', message: 'The branch is behind its base. Update it first.' };
  if (pr.mergeState === 'UNSTABLE')
    return { reason: 'unstable', message: 'A check did not pass. Open the pull request on GitHub to merge it anyway.' };
  if (pr.mergeState === 'BLOCKED')
    return { reason: 'protected', message: 'Branch protection is not satisfied: a required review or check is missing.' };
  return { reason: 'computing', message: 'GitHub is still working out whether this can merge. Refresh in a moment.' };
}
