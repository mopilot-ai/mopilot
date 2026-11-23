// Confirm whether a repository has a symbolic branch without its first commit.
/** Confirm an unborn branch before treating a failed HEAD lookup as an empty repository. */
export async function isUnbornHead(run) {
  const repository = await run(['rev-parse', '--is-inside-work-tree']);
  if (!repository.ok || repository.stdout.trim() !== 'true') return false;
  const branch = await run(['symbolic-ref', '--quiet', 'HEAD']);
  const ref = branch.stdout.trim();
  if (!branch.ok || !ref) return false;
  const existing = await run(['show-ref', '--verify', '--quiet', ref]);
  return !existing.ok && existing.code === 1;
}
