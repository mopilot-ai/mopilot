// The summary panel's Pull requests card, on every harness: the chat family's open PRs, those waiting on input first, then
// what merged, the same list as the status line's tray (thread/usePrInbox.ts), reachable when that line is scrolled away.
// A question opens the session asking it; any other row, its PR. As Claude Desktop's Changes, five rows show before "Show N
// more", and the count goes to the section's summary. SummaryPanel loads it on first use.
import { useEffect, useState, type MouseEvent } from 'react';
import { landedWhen, TAG_WORD, type InboxRow } from '../../lib/prInbox';
import { openLink } from '../../session/open';
import { openChatFrom } from '../../session/openChat';
import { PullRequestIcon } from '../markdown/PullRequestIcon';
import { SessionStateProbe } from '../thread/SessionCard';
import { useSessionStates } from '../thread/sessionStates';
import { usePrInbox } from '../thread/usePrInbox';

/** Rows shown before "Show N more". */
const PRS_SHOWN = 5;

export function SummaryPullRequests({ threadId, onCount }: { threadId: string; onCount?: (count: number) => void }) {
  const [states, onState] = useSessionStates();
  const { view, family } = usePrInbox(threadId, states, { all: true });
  const [all, setAll] = useState(false);
  const every = [...view.needs, ...view.moving, ...view.landed];
  const rows = all ? every : every.slice(0, PRS_SHOWN);
  useEffect(() => {
    onCount?.(every.length);
  }, [onCount, every.length]);
  // a session's question is answered in that session; anything else is the PR's own page
  const open = (e: MouseEvent, r: InboxRow) => (r.tag === 'asks' ? openChatFrom(e, r.chatId) : openLink(r.url));
  const hint = (r: InboxRow) =>
    r.group === 'landed' && r.pr?.mergedAt !== undefined ? landedWhen(r.pr.mergedAt, Date.now()) : TAG_WORD[r.tag];
  return (
    <>
      {family.map((id) => (
        <SessionStateProbe key={id} chatId={id} onState={onState} />
      ))}
      {rows.length > 0 && (
        <section className="summary-pr-list" aria-label="Pull requests">
          <div className="summary-subhead">Pull requests</div>
          {rows.map((r) => (
            <button key={r.url} className="summary-row" title={r.text} onClick={(e) => open(e, r)}>
              <PullRequestIcon state={r.pr?.state ?? 'open'} size={15} />
              <span className="summary-label">{r.pr?.title ?? `#${r.url.split('/').at(-1)}`}</span>
              <span className="summary-hint">{hint(r)}</span>
            </button>
          ))}
          {!all && every.length > PRS_SHOWN && (
            <button className="summary-row" onClick={() => setAll(true)}>
              <span className="summary-label">Show {every.length - PRS_SHOWN} more</span>
            </button>
          )}
        </section>
      )}
    </>
  );
}
