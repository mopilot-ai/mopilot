// The heading a review card shows for what the review looked at.

/** What a review looked at, as the card's heading says it. A pull request reviews as a custom target on Codex, so callers pass 'pullRequest'. */
export function reviewTargetLabel(target: string | null | undefined): string | null {
  switch (target) {
    case 'pullRequest':
      return 'Pull request';
    case 'uncommittedChanges':
      return 'Uncommitted changes';
    case 'baseBranch':
      return 'Against a branch';
    case 'commit':
      return 'Commit';
    case 'custom':
      return 'Custom review';
    default:
      return null;
  }
}
