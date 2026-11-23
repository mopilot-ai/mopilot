// MoMo's approval card (MacApprove, W5.1–W5.2): who it goes to and the exact message, with Send, Edit and Don't send; expired, answered elsewhere, sent, not sent and uncertain are each a state of the same card.
import { useState } from 'react';
import { momoApprovalAnswerable, momoApprovalStatus, type MomoApprovalView } from '../../../../shared/momoView';
import { busyField } from '../../../lib/focus';
import { clock } from './homeCopy';
import { Refusal } from './Refusal';
import { useNow } from './useNow';
import { useMomoAct } from './useMomoHome';
import styles from './home.module.css';

export function ApprovalCard({ a, now: fixedNow }: { a: MomoApprovalView; now?: number }) {
  const { act, busy, failed } = useMomoAct();
  // a card judged by the clock expires on screen when its time comes
  const now = useNow(a.expiresAt, fixedNow);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(a.body);
  const status = momoApprovalStatus(a, now);
  const to = a.recipients.map((r) => r.name).join(', ');
  const outside = a.recipients.filter((r) => r.outsideCompany).length;
  const closed = (title: string, text: string, buttons?: React.ReactNode) => (
    <div className={styles.card} role="group" aria-label={a.title} data-status={status} data-testid={`momo-card-${a.id}`}>
      <h3 className={styles.h1}>{title}</h3>
      <p className={styles.text}>{text}</p>
      {buttons ? <div className={styles.actions}>{buttons}</div> : null}
      <Refusal failed={failed} />
    </div>
  );
  const mail = a.action === 'send-email';
  const ask = () =>
    a.canAskAgain || status === 'expired' ? (
      <button type="button" className={styles.btn} disabled={busy} onClick={() => void act({ type: 'approval.askAgain', id: a.id })}>
        Ask again
      </button>
    ) : undefined;
  if (a.answeredElsewhere) {
    const e = a.answeredElsewhere;
    return closed(
      `Answered on ${e.device ? `your ${e.device}` : 'another device'} at ${clock(e.at)}`,
      e.outcome === 'approved' ? (mail ? `You sent the email to ${to}.` : 'You approved it.') : 'You chose not to do it.',
    );
  }
  if (status === 'void') return closed('No longer valid', a.failure?.cause || 'MoMo moved, so this card can’t be answered.', ask());
  if (status === 'completed') return closed(mail ? `Sent to ${to}.` : 'Done.', 'The card is closed on every device.');
  if (status === 'approved' || status === 'consumed') return closed('Approved.', 'MoMo is doing it.');
  if (status === 'denied') return closed(mail ? 'Not sent.' : 'Not done.', 'MoMo will not try this again.', ask());
  if (status === 'expired') return closed('Expired', 'Nobody answered in 30 minutes. Nothing was done.', ask());
  if (status === 'uncertain')
    return closed('Not sure this was done.', mail ? 'Check Sent in Gmail before trying again.' : 'Check before trying again.', ask());
  if (status === 'failed' || a.failure)
    return closed(
      'Couldn’t finish.',
      a.failure?.cause ?? 'It did not finish.',
      a.failure?.fix ? (
        <button type="button" className={styles.btn} disabled={busy} onClick={() => void act({ type: 'fix.run', id: a.failure!.fix!.id })}>
          {a.failure.fix.label}
        </button>
      ) : undefined,
    );
  // a status this client does not know offers no way to answer
  if (!momoApprovalAnswerable(a, now)) return closed(a.title, `This card is ${status}.`);
  return (
    <div className={styles.card} role="group" aria-label={a.title} aria-busy={busy} data-status={status} data-testid={`momo-card-${a.id}`}>
      <h3 className={styles.h1}>
        {a.title}{' '}
        {outside ? (
          <span className={styles.meta}>
            {outside} {outside === 1 ? 'person' : 'people'} outside your company
          </span>
        ) : null}
      </h3>
      <dl style={{ margin: 0 }}>
        {a.recipients.length ? (
          <>
            <dt className={styles.meta}>To</dt>
            <dd style={{ margin: 0 }}>{a.recipients.map((r) => `${r.name} · ${r.address}`).join(', ')}</dd>
          </>
        ) : null}
        {a.fields.map((f) => (
          <div key={f.label}>
            <dt className={styles.meta}>{f.label}</dt>
            <dd style={{ margin: 0 }}>{f.value}</dd>
          </div>
        ))}
        {a.subject ? (
          <>
            <dt className={styles.meta}>Subject</dt>
            <dd style={{ margin: 0 }}>{a.subject}</dd>
          </>
        ) : null}
        {a.attachments.length ? (
          <>
            <dt className={styles.meta}>Attached</dt>
            <dd style={{ margin: 0 }}>{a.attachments.join(', ')}</dd>
          </>
        ) : null}
      </dl>
      {editing ? (
        <textarea
          ref={(el) => el?.focus()}
          className={styles.field}
          aria-label="Message"
          rows={5}
          value={draft}
          {...busyField(busy)}
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : (
        <p className={styles.text}>{a.body}</p>
      )}
      <div className={styles.actions}>
        {editing ? (
          <>
            <button
              type="button"
              className={styles.primary}
              disabled={busy || !draft.trim()}
              onClick={() => void act({ type: 'approval.edit', id: a.id, body: draft }).then((r) => r.ok && setEditing(false))}
            >
              Save
            </button>
            <button type="button" className={styles.btn} disabled={busy} onClick={() => (setDraft(a.body), setEditing(false))}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" className={styles.primary} disabled={busy} onClick={() => void act({ type: 'approval.send', id: a.id })}>
              {mail ? 'Send' : 'Approve'}
            </button>
            {a.editable === true ? (
              <button type="button" className={styles.btn} disabled={busy} onClick={() => setEditing(true)}>
                Edit
              </button>
            ) : null}
            <button type="button" className={styles.btn} disabled={busy} onClick={() => void act({ type: 'approval.deny', id: a.id })}>
              {mail ? 'Don’t send' : 'Don’t do it'}
            </button>
          </>
        )}
      </div>
      <Refusal failed={failed} />
      {busy ? (
        <p className={styles.meta} role="status">
          Working…
        </p>
      ) : null}
      <p className={styles.meta}>Asked on this Mac and on your iPhone</p>
    </div>
  );
}
