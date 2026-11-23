// One pull request row of the PR inbox (PrInbox.tsx, PrInboxAll.tsx): its title and number, its session, why it is
// listed or where it stands on its way to main, and the one action that unblocks it.
import type { MouseEvent } from 'react';
import { native } from '../../lib/native';
import { ignoring } from '../../lib/ignored';
import { landedWhen, TAG_WORD, type InboxRow } from '../../lib/prInbox';
import { openLink } from '../../session/open';
import { openChatFrom } from '../../session/openChat';
import { sendOrDraft } from '../../store/send';
import { toastFailure } from '../../store/core';
import { PullRequestIcon } from '../markdown/PullRequestIcon';
import styles from './prInbox.module.css';

/** What answering a session's question from the tray did. */
export type Answer = 'sent' | 'drafted';

/** A question's key: the session and its words, so a new question is answerable again; else the PR it is about. */
export const askKey = (r: InboxRow) => `${r.chatId}\n${r.ask?.text ?? r.url}`;

export function InboxRowItem({
  row,
  onDone,
  answer,
  onAnswer,
  own = 'this chat',
}: {
  row: InboxRow;
  onDone: () => void;
  answer?: Answer;
  onAnswer: (a: Answer) => void;
  /** what the main chat's own PR names as its chat (another chat's section names that chat) */
  own?: string;
}) {
  const pr = row.pr;
  const number = pr?.number ?? Number(row.url.split('/').at(-1));
  const title = pr?.title ?? `Pull request #${number}`;
  const openSession = (e: MouseEvent) => {
    onDone();
    openChatFrom(e, row.chatId);
  };
  return (
    <div className={styles.row} data-group={row.group} data-tag={row.tag}>
      <span className={styles.icon} data-state={pr?.state ?? 'unknown'}>
        <PullRequestIcon state={pr?.state ?? 'open'} size={15} />
      </span>
      {/* the whole title on hover: the row cuts a long one */}
      <button className={styles.title} title={`${title}\nOpen #${number} on GitHub`} onClick={() => openLink(row.url)}>
        {title}
      </button>
      <span className={styles.meta}>
        <span className={styles.num}>#{number}</span>
        <span aria-hidden="true">·</span>
        {row.session ? (
          <button className={styles.session} title="Open the session" onClick={openSession}>
            {row.session}
          </button>
        ) : (
          <span>{own}</span>
        )}
      </span>
      <span className={styles.why}>
        {/* a PR on its way shows where it stands instead of a word for it */}
        {row.step ? (
          <Track step={row.step} text={row.text} />
        ) : row.group === 'landed' ? (
          // its group and icon already say merged: what the row adds is when
          <span className={styles.text}>{pr?.mergedAt === undefined ? row.text : landedWhen(pr.mergedAt, Date.now())}</span>
        ) : (
          <>
            <span className={styles.tag} data-tag={row.tag}>
              {TAG_WORD[row.tag]}
            </span>
            {/* a question reads whole, over up to three lines: the user answers it here */}
            <span className={styles.text} title={row.text}>
              {row.text}
            </span>
          </>
        )}
      </span>
      <Actions row={row} answer={answer} onAnswer={onAnswer} openSession={openSession} />
    </div>
  );
}

/** The rows that offer the user a click: a question's answers, and what settles a PR nothing else will. */
const ACTIONABLE: ReadonlySet<InboxRow['tag']> = new Set(['asks', 'check', 'review', 'merge', 'stuck']);

/** The steps a PR's track names: the merge robot's (its gate, then its train) for a PR it lands, else a plain merge. */
const ROBOT_STEPS = ['Checks', 'Gate', 'Merge train', 'Main'];
const PLAIN_STEPS = ['Checks', 'Merge', 'Main'];
const STEP_AT: Record<NonNullable<InboxRow['step']>, number> = { checks: 0, merge: 1, gate: 1, train: 2 };

function Track({ step, text }: { step: NonNullable<InboxRow['step']>; text: string }) {
  const at = STEP_AT[step];
  const names = step === 'gate' || step === 'train' ? ROBOT_STEPS : PLAIN_STEPS;
  return (
    <span className={styles.track} aria-label={text}>
      {names.map((name, i) => (
        <span key={name} className={styles.step} data-at={i < at ? 'done' : i === at ? 'now' : 'next'}>
          <i aria-hidden="true" />
          {i === at ? text : name}
        </span>
      ))}
    </span>
  );
}

function Actions({
  row,
  answer,
  onAnswer,
  openSession,
}: {
  row: InboxRow;
  answer?: Answer;
  onAnswer: (a: Answer) => void;
  openSession: (e: MouseEvent) => void;
}) {
  // what the user may act on, though only a question waits on them; the rest moves by itself
  if (!ACTIONABLE.has(row.tag)) return null;
  if (row.tag === 'asks') {
    // the session, to read what the question is about before answering it
    const open = (
      <button className={styles.btn} onClick={openSession}>
        Open session
      </button>
    );
    if (answer)
      return (
        <span className={styles.actions}>
          <span className={styles.sent}>{answer === 'sent' ? 'Sent' : 'Not sent · in its draft'}</span>
          {open}
        </span>
      );
    const actions = row.ask?.actions ?? [];
    return (
      <span className={styles.actions}>
        {actions.map((a, i) => (
          <button
            key={a.label}
            className={i === 0 ? `${styles.btn} ${styles.primary}` : styles.btn}
            onClick={() => {
              onAnswer('sent');
              // as the wrap-up box sends it: the user's own words only when what goes is the label they clicked
              const text = a.message ?? a.label;
              void sendOrDraft(row.chatId, text, { human: text === a.label })
                .then((sent) => sent === false && onAnswer('drafted'))
                .catch(ignoring('send an answer from the PR inbox'));
            }}
          >
            {a.label}
          </button>
        ))}
        {open}
      </span>
    );
  }
  // a fix the gate holds unverified: its chat verifies it and fills in the section, or the user does on GitHub
  if (row.tag === 'check' && row.request) {
    const request = row.request;
    return (
      <span className={styles.actions}>
        {answer ? (
          <span className={styles.sent}>{answer === 'sent' ? 'Asked' : 'Not sent · in its draft'}</span>
        ) : (
          <button
            className={`${styles.btn} ${styles.primary}`}
            title="Ask its chat to verify the fix and fill in its description"
            onClick={() => {
              onAnswer('sent');
              void sendOrDraft(row.chatId, request)
                .then((sent) => sent === false && onAnswer('drafted'))
                .catch(ignoring('ask a chat to verify its fix from the PR inbox'));
            }}
          >
            Ask to verify
          </button>
        )}
        <button className={styles.btn} onClick={() => openLink(row.url)}>
          Open PR
        </button>
      </span>
    );
  }
  // what only the user does on GitHub: merge it or review it
  const onGitHub = { merge: 'Review & merge', review: 'Review' }[row.tag as 'merge' | 'review'];
  if (onGitHub)
    return (
      <span className={styles.actions}>
        <button className={`${styles.btn} ${styles.primary}`} onClick={() => openLink(row.url)}>
          {onGitHub}
        </button>
      </span>
    );
  const retry = !!row.monitor && (row.monitor.limited || row.monitor.uncertain);
  return (
    <span className={styles.actions}>
      {retry && (
        <button
          className={styles.btn}
          onClick={() => void native.prMonitor.configure(row.chatId, { retry: true }).catch(toastFailure("Couldn't retry auto-fix"))}
        >
          Retry
        </button>
      )}
      <button className={styles.btn} onClick={openSession}>
        Open session
      </button>
    </span>
  );
}
