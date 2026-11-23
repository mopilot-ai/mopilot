// A chat's pull requests as the sidebar badge's hover card (#1581), laid out as Claude Code lists a session's: each PR's
// title over its state icon and state, repository and number, and lines added and removed, opening the PR on click.

import type { ThreadPullRequest } from '../../lib/threadPullRequest';
import { pullRequestPresentation } from '../../lib/pullRequestIndicator';
import { openLink } from '../../session/open';
import { useCloseTooltip } from '../ui/Popover';
import { PullRequestIcon } from './PullRequestIcon';

/** "PR #42 · reported merged · Fix the thing": a PR in words, for a label or a tooltip. */
export function pullRequestLabel(pr: ThreadPullRequest): string {
  const { label: state } = pullRequestPresentation(pr);
  return `PR #${pr.number} · ${pr.source === 'response' ? 'reported ' : ''}${state}${pr.title ? ` · ${pr.title}` : ''}`;
}

/** "owner/repo" from a PR's GitHub URL, or null for a URL without one. */
export function pullRequestRepository(url: string): string | null {
  return /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//i.exec(url)?.[1] ?? null;
}

/** The hover card: one row per PR, the chat's latest first. */
export function PullRequestList({ entries }: { entries: ThreadPullRequest[] }) {
  const close = useCloseTooltip();
  return (
    <ul className="thread-pr-list" aria-label="Pull requests">
      {entries.map((pr) => {
        const { label, indicator } = pullRequestPresentation(pr);
        const state = pr.source === 'response' ? `reported ${label}` : label;
        const repository = pullRequestRepository(pr.url);
        return (
          <li key={pr.url}>
            <button
              className={`thread-pr-list-item ${pr.state}`}
              aria-label={pullRequestLabel(pr)}
              onClick={(e) => {
                e.stopPropagation();
                close();
                openLink(pr.url);
              }}
            >
              <span className="thread-pr-list-title">{pr.title || `PR #${pr.number}`}</span>
              <span className="thread-pr-list-meta">
                <span className="thread-pr-list-state" data-indicator={indicator}>
                  <PullRequestIcon state={pr.state} size={14} />
                  {state.charAt(0).toUpperCase() + state.slice(1)}
                </span>
                <span className="thread-pr-list-number">
                  {' · '}
                  {repository ? `${repository} ` : ''}#{pr.number}
                </span>
                {pr.additions !== undefined && pr.deletions !== undefined && (
                  <span className="thread-pr-list-stats">
                    <span className="plus">+{pr.additions}</span> <span className="minus">−{pr.deletions}</span>
                  </span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
