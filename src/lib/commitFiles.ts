// What a failed commit from the Changes pane (electron/platform/commitFiles.cjs) says to the user: the common causes by name, else where to look; git's own words go to the log.

type Failed = { stdout: string; stderr: string; refused?: true };

export function commitFailure(result: Failed): string {
  // main's own refusal is already a sentence
  if (result.refused) return result.stderr;
  const said = `${result.stderr}\n${result.stdout}`.trim();
  console.warn(`[commit] git refused the commit: ${said}`);
  if (/nothing (added )?to commit|no changes added to commit/i.test(said)) return 'There is nothing to commit.';
  if (/please tell me who you are|empty ident|user\.email/i.test(said))
    return 'Git doesn’t know who you are. Set user.name and user.email in git, then try again.';
  if (/index\.lock/i.test(said)) return 'Another git command is using this repository. Try again when it finishes.';
  // git names a hook itself only in these words; a hook's own output can say anything, a path anything too
  if (/hook declined|\b(pre-commit|commit-msg|prepare-commit-msg) hook\b/i.test(said))
    return 'A commit hook stopped the commit. Its output is in the log.';
  return 'Git couldn’t commit. Its output, or a commit hook’s, is in the log.';
}
