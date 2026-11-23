// The PR inbox's All chats scope (PrInbox.tsx), on every harness: every main chat's pull requests, one section per chat
// with what needs the user, its other open PRs and what merged today, the chats with something for the user first; each
// section reads its own family, without the older PRs the list of a chat on screen reads.
import { useEffect, useState } from 'react';
import type { OrchestrationView } from '../../../shared/orchestration';
import { useOrchestration } from '../../lib/sideSessions';
import { useStore, threadTitle } from '../../store/core';
import { openChatFrom } from '../../session/openChat';
import type { InboxRow } from '../../lib/prInbox';
import { ChevronDown, ChevronRight } from '../ui/icons';
import { SessionStateProbe } from './SessionCard';
import { useSessionStates } from './sessionStates';
import { usePrInbox } from './usePrInbox';
import { askKey, InboxRowItem, type Answer } from './PrInboxRow';
import styles from './prInbox.module.css';

/** The chats that started sessions and are not one themselves (a detached one stands on its own), each once. */
export function mainChats(view: OrchestrationView): string[] {
  const roots = new Set<string>();
  for (const c of Object.values(view.children)) {
    if (c.detached) continue;
    const parent = view.children[c.parentId];
    if (!parent || parent.detached) roots.add(c.parentId);
  }
  return [...roots];
}

type Rows = { answers: Record<string, Answer>; onAnswer: (key: string, a: Answer) => void; onDone: () => void };

/** Every main chat's section; `current`: the chat the tray opened from, named as such. */
export function AllChatsInbox({ current, ...rows }: { current: string } & Rows) {
  // each section's "needs you" count and how many PRs it lists, as it reports them
  const [needs, setNeeds] = useState<Record<string, number>>({});
  const [listed, setListed] = useState<Record<string, number>>({});
  // the chats with something for the user first, in the DOM too, so focus and screen readers go in the order shown
  const roots = mainChats(useOrchestration()).sort((a, b) => (needs[b] ?? 0) - (needs[a] ?? 0));
  return (
    <div className={styles.all}>
      {/* the tray opens for this chat's older merges too, and a chat that started no session has no section here */}
      {roots.every((id) => listed[id] === 0) && <p className={styles.none}>Nothing open or merged today</p>}
      {roots.map((id) => (
        <ChatSection
          key={id}
          chatId={id}
          current={id === current}
          onNeeds={(n) => setNeeds((was) => (was[id] === n ? was : { ...was, [id]: n }))}
          onListed={(n) => setListed((was) => (was[id] === n ? was : { ...was, [id]: n }))}
          {...rows}
        />
      ))}
    </div>
  );
}

function ChatSection({
  chatId,
  current,
  onNeeds,
  onListed,
  answers,
  onAnswer,
  onDone,
}: { chatId: string; current: boolean; onNeeds: (n: number) => void; onListed: (n: number) => void } & Rows) {
  const [states, onState] = useSessionStates();
  // every main chat started a session, so it has a view
  const { view: found, family } = usePrInbox(chatId, states);
  const view = found!;
  const title = useStore((s) => threadTitle(s.threads[chatId]));
  const [movingOpen, setMovingOpen] = useState(false);
  const [landedOpen, setLandedOpen] = useState(false);
  const needs = view.needs.length;
  const moving = view.moving.length;
  const landed = view.landed.length;
  useEffect(() => onNeeds(needs), [onNeeds, needs]);
  useEffect(() => onListed(needs + moving + landed), [onListed, needs, moving, landed]);
  const rows = (list: InboxRow[]) =>
    list.map((r) => (
      <InboxRowItem
        key={r.url}
        row={r}
        own="main chat"
        onDone={onDone}
        answer={answers[askKey(r)]}
        onAnswer={(a) => onAnswer(askKey(r), a)}
      />
    ));
  return (
    <>
      {family.map((id) => (
        <SessionStateProbe key={id} chatId={id} onState={onState} />
      ))}
      {needs + moving + landed > 0 && (
        <section aria-label={title} className={styles.chat}>
          <h3 className={styles.chatHead}>
            <button
              className={styles.chatTitle}
              title="Open the chat"
              onClick={(e) => {
                onDone();
                openChatFrom(e, chatId);
              }}
            >
              {title}
            </button>
            {current && <span className={styles.count}>this chat</span>}
            {needs > 0 && (
              <span className={styles.rowCount} role="img" aria-label={needs === 1 ? '1 needs you' : `${needs} need you`}>
                {needs}
              </span>
            )}
          </h3>
          {rows(view.needs)}
          {moving > 0 && (
            <button className={styles.fold} aria-expanded={movingOpen} onClick={() => setMovingOpen(!movingOpen)}>
              {movingOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
              {`${needs ? 'Other open PRs' : 'Open PRs'} (${moving})`}
            </button>
          )}
          {movingOpen && rows(view.moving)}
          {landed > 0 && (
            <button className={styles.fold} aria-expanded={landedOpen} onClick={() => setLandedOpen(!landedOpen)}>
              {landedOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
              {`Merged today (${landed})`}
            </button>
          )}
          {landedOpen && rows(view.landed)}
        </section>
      )}
    </>
  );
}
