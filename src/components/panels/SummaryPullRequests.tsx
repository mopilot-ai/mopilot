// The summary panel's Pull requests card, on every harness: the chat family's open PRs, those waiting on input first, then
// what merged, the same list as the status line's tray (thread/usePrInbox.ts), reachable when that line is scrolled away.
// A question opens the session asking it; any other row, its PR. SummaryPanel loads it on first use.
import { useState, type MouseEvent } from 'react';
import { landedWhen, MERGED_SHOWN, TAG_WORD, type InboxRow } from '../../lib/prInbox';
import { openLink } from '../../session/open';
import { openChatFrom } from '../../session/openChat';
import { PullRequestIcon } from '../markdown/PullRequestIcon';
import { SessionStateProbe } from '../thread/SessionCard';
import { useSessionStates } from '../thread/sessionStates';
import { usePrInbox } from '../thread/usePrInbox';

export function SummaryPullRequests({ threadId }: { threadId: string }) {
  const [states, onState] = useSessionStates();
  const { view, family } = usePrInbox(threadId, states, { all: true });
  const [allMerged, setAllMerged] = useState(false);
  const landed = view.landed;
  const merged = allMerged ? landed : landed.slice(0, MERGED_SHOWN);
  const rows = [...view.needs, ...view.moving, ...merged];
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
        <section className="summary-group" aria-label="Pull requests">
          <div className="summary-subhead">Pull requests</div>
          {rows.map((r) => (
            <button key={r.url} className="summary-row" title={r.text} onClick={(e) => open(e, r)}>
              <PullRequestIcon state={r.pr?.state ?? 'open'} size={15} />
              <span className="summary-label">{r.pr?.title ?? `#${r.url.split('/').at(-1)}`}</span>
              <span className="summary-hint">{hint(r)}</span>
            </button>
          ))}
          {!allMerged && landed.length > MERGED_SHOWN && (
            <button className="summary-row" onClick={() => setAllMerged(true)}>
              <span className="summary-label">Show {landed.length - MERGED_SHOWN} more</span>
            </button>
          )}
        </section>
      )}
    </>
  );
}
