// The chat's PR rail: Claude Code's compact rows, with earlier merges folded while PRs remain open.
import { useState, type ReactNode } from 'react';
import { MERGED_SHOWN, type InboxRow, type InboxView } from '../../lib/prInbox';
import { pullRequestPresentation } from '../../lib/pullRequestIndicator';
import { openLink } from '../../session/open';
import { PullRequestIcon } from '../markdown/PullRequestIcon';
import { ChevronRight } from '../ui/icons';
import styles from './prInboxRail.module.css';

export function PrInboxRail({ view, children }: { view: InboxView; children: ReactNode }) {
  const [showAll, setShowAll] = useState(false);
  const [earlierOpen, setEarlierOpen] = useState(false);
  const open = [...view.needs, ...view.moving];
  // Claude Code shows the ended rows themselves when there is no open PR to keep ahead of them.
  const current = open.length ? open : view.landed;
  const earlier = open.length ? view.landed : [];
  const hidden = current.length - MERGED_SHOWN;
  // As in the Changes card, a fold that disappears retires its expansion before the next list needs it.
  if (showAll && hidden <= 0) setShowAll(false);
  if (earlierOpen && earlier.length === 0) setEarlierOpen(false);
  const row = (r: InboxRow) => {
    const pr = r.pr;
    const number = pr?.number ?? Number(r.url.split('/').at(-1));
    const title = pr?.title || `Pull request #${number}`;
    const state = pr?.state ?? 'unknown';
    const status = pullRequestPresentation(pr ?? { state, url: r.url, number }).label;
    return (
      <li key={r.url}>
        <button
          className={styles.row}
          aria-label={`Open pull request #${number}: ${title}`}
          title={`${title} · ${pr?.source === 'response' ? 'reported ' : ''}${status}`}
          onClick={() => openLink(r.url)}
        >
          <span className={styles.icon} data-state={state}>
            <PullRequestIcon state={state} size={15} />
          </span>
          <span className={styles.number}>#{number}</span>
          <span className={styles.title}>{title}</span>
        </button>
      </li>
    );
  };
  return (
    <section className={styles.rail} aria-label="Chat pull requests">
      <div className={styles.head}>
        <span>Pull requests</span>
        {children}
      </div>
      <ul className={styles.rows} aria-label="Current pull requests">
        {(showAll ? current : current.slice(0, MERGED_SHOWN)).map(row)}
      </ul>
      {hidden > 0 && (
        <button className={styles.fold} aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show less' : `Show ${hidden} more`}
        </button>
      )}
      {earlier.length > 0 && (
        <>
          <button className={styles.fold} aria-expanded={earlierOpen} onClick={() => setEarlierOpen(!earlierOpen)}>
            <ChevronRight size={12} className={styles.caret} aria-hidden />
            <span>
              {earlier.length} earlier pull {earlier.length === 1 ? 'request' : 'requests'}
            </span>
            <span className={styles.merged}>{earlier.length} merged</span>
          </button>
          {earlierOpen && (
            <ul className={styles.rows} aria-label="Earlier pull requests">
              {earlier.map(row)}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
