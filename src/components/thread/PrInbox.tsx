// A chat's PR inbox, on every harness: its family's PR rail (PrCount.tsx) with attention only for
// a session's question or approval, and its tray listing those PRs, where a session's question is answered in place
// (designs/session-prs-compact).
import { memo, useEffect, useRef, useState } from 'react';
import { focusAfterPlacement } from '../../lib/placedFocus';
import { usePrInbox } from './usePrInbox';
import { inboxCount, MERGED_SHOWN, type InboxRow, type InboxView } from '../../lib/prInbox';
import { Popover } from '../ui/Popover';
import { SessionStateProbe } from './SessionCard';
import { useSessionStates } from './sessionStates';
import { askKey, InboxRowItem, type Answer } from './PrInboxRow';
import { AllChatsInbox } from './PrInboxAll';
import { clearPrLine, setPrLine, usePrLine } from './prLine';

/** What the tray lists: this chat's family, or every main chat's. */
type Scope = 'chat' | 'all';
import styles from './prInbox.module.css';

/**
 * The chat's inbox for as long as it is on screen: the probes that tell it each session's state, what its rail shows,
 * and the tray, which stays open across live/completed turns. ComposerPills
 * loads this module only for a chat that can act on its sessions.
 */
export const PrInboxOwner = memo(function PrInboxOwner({ threadId }: { threadId: string }) {
  const [states, onState] = useSessionStates();
  const { view, family } = usePrInbox(threadId, states, { all: true });
  const { tray, anchor } = usePrLine(threadId);
  const count = inboxCount(view);
  // By value: a fresh read makes a new view; the rail also needs title/state updates that don't change the count.
  const line = JSON.stringify(view);
  useEffect(() => {
    const view = JSON.parse(line) as InboxView;
    setPrLine(threadId, { count: inboxCount(view), asking: view.needs.map((r) => r.chatId), view });
  }, [threadId, line]);
  useEffect(() => () => clearPrLine(threadId), [threadId]);
  // this chat's family or every main chat's, kept while the tray closes and opens
  const [scope, setScope] = useState<Scope>('chat');
  // what each question got, kept while the tray closes and opens, so a reply waiting behind a busy turn isn't sent twice
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const close = () => setPrLine(threadId, { tray: false });
  return (
    <>
      {family.map((id) => (
        <SessionStateProbe key={id} chatId={id} onState={onState} />
      ))}
      <Popover
        anchor={anchor}
        open={tray && !!count && !!anchor}
        onClose={() => {
          close();
          anchor?.focus();
        }}
        placement="top-start"
        offset={8}
      >
        <PrInboxTray
          threadId={threadId}
          scope={scope}
          onScope={setScope}
          view={view}
          onDone={close}
          answers={answers}
          onAnswer={(key, a) => setAnswers((was) => ({ ...was, [key]: a }))}
        />
      </Popover>
    </>
  );
});

/** The tray: the family's open PRs, those waiting on the user first, then what merged, newest first. */
export function PrInboxTray({
  threadId,
  scope,
  onScope,
  view,
  onDone,
  answers,
  onAnswer,
}: {
  threadId: string;
  scope: Scope;
  onScope: (s: Scope) => void;
  view: InboxView;
  onDone: () => void;
  /** what each question got, by askKey */
  answers: Record<string, Answer>;
  onAnswer: (key: string, a: Answer) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => focusAfterPlacement(ref.current!), []);
  const [allMerged, setAllMerged] = useState(false);
  const rows = (list: InboxRow[]) =>
    list.map((r) => (
      <InboxRowItem key={r.url} row={r} onDone={onDone} answer={answers[askKey(r)]} onAnswer={(a) => onAnswer(askKey(r), a)} />
    ));
  const open = [...view.needs, ...view.moving];
  const hidden = view.landed.length - MERGED_SHOWN;
  return (
    <div ref={ref} className={styles.tray} role="dialog" aria-label="Pull requests" tabIndex={-1}>
      <div className={styles.head}>
        Pull requests
        <span className={styles.seg} role="group" aria-label="Show">
          {(['chat', 'all'] as const).map((s) => (
            <button key={s} aria-pressed={scope === s} onClick={() => onScope(s)}>
              {s === 'chat' ? 'This chat' : 'All chats'}
            </button>
          ))}
        </span>
      </div>
      {scope === 'all' ? (
        <div className={styles.body}>
          <AllChatsInbox current={threadId} answers={answers} onAnswer={onAnswer} onDone={onDone} />
        </div>
      ) : (
        <div className={styles.body}>
          {open.length > 0 && (
            <section aria-label="Open">
              <h3 className={styles.group}>
                Open <span className={styles.count}>{open.length}</span>
              </h3>
              {rows(open)}
            </section>
          )}
          {view.landed.length > 0 && (
            <section aria-label="Merged">
              <h3 className={styles.group}>
                Merged <span className={styles.count}>{view.landed.length}</span>
              </h3>
              {rows(allMerged ? view.landed : view.landed.slice(0, MERGED_SHOWN))}
              {!allMerged && hidden > 0 && (
                <button className={styles.fold} onClick={() => setAllMerged(true)}>
                  Show {hidden} more
                </button>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
