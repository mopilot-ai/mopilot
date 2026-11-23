// A GitHub pull request link in a message, as Claude Code's app shows one: a chip with the PR's state icon, "owner/repo#N" and its title, kept current while the window is in use.

import { visiblePoll } from '../../lib/visiblePoll';
import { useState, type MouseEvent } from 'react';
import { useEffectOn } from '../../lib/effects';
import { readPullRequest } from '../../session/pullRequestReader';
import type { ThreadPullRequest } from '../../lib/threadPullRequest';
import { pullRequestPresentation } from '../../lib/pullRequestIndicator';
import { PullRequestIcon } from './PullRequestIcon';

/** How often a shown PR's status is read again; focus also refreshes, and merged PRs remain cached. */
export const REFRESH_MS = 60_000;

/**
 * `url` is the PR's canonical link (shared/pullRequest.mjs), `href` the link as written, which a click opens.
 * Until `live` (a streaming reply's last run may still change the link), the chip shows the reference without a status.
 */
export function PullRequestLink({
  url,
  href,
  live,
  onOpen,
}: {
  url: string;
  href: string;
  live: boolean;
  onOpen: (e: MouseEvent) => void;
}) {
  const [result, setResult] = useState<{ url: string; pr: ThreadPullRequest } | null>(null);
  useEffectOn([url, live], () => {
    if (!live) return;
    let alive = true;
    let busy = false;
    let again = false;
    const refresh = async () => {
      if (!alive) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        const pr = await readPullRequest.status(url, true);
        if (alive && !again) setResult({ url, pr });
      } catch {
        /* the chip keeps what it showed */
      } finally {
        busy = false;
        if (alive && again) {
          again = false;
          void refresh();
        }
      }
    };
    void refresh();
    const stop = visiblePoll('pull-request-chip', REFRESH_MS, () => void refresh());
    return () => {
      alive = false;
      stop();
    };
  });
  // a status read for another link (the href changed meanwhile) is not this one's
  const pr = result?.url === url ? result.pr : null;
  // the link as written keeps GitHub's casing of owner and repository; the canonical one is lowercased
  const [, owner, repo, , number] = new URL(href).pathname.split('/');
  const ref = `${owner}/${repo}#${number}`;
  const state = pr?.state ?? 'unknown';
  const status = pr ? pullRequestPresentation(pr).label : 'loading status';
  return (
    <a
      className={`md-pr-chip ${pr ? state : 'loading'}`}
      href={href}
      title={`${status} · ${href}`}
      aria-label={`Pull request ${ref} · ${status}${pr?.title ? ` · ${pr.title}` : ''}`}
      onClick={(e) => {
        e.preventDefault();
        onOpen(e);
      }}
    >
      <span className="md-pr-chip-icon" aria-hidden="true">
        <PullRequestIcon state={state} size={13} />
      </span>
      <span className="md-pr-chip-ref">{ref}</span>
      {pr?.title && (
        <>
          {/* real text, so a copied message keeps the separator between reference and title */}
          <span className="md-pr-chip-sep">·</span>
          <span className="md-pr-chip-title">{pr.title}</span>
        </>
      )}
    </a>
  );
}
