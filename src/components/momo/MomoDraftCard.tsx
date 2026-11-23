// A draft MoMo wrote for the user (A3, a note of kind 'draft' in the chat, electron/momo/draftTools.cjs), drawn as an Email card: a plain line above it in MoMo's words ("Draft email to … with subject …, from …"), the card (envelope, a copy icon and × at the top right, the title Email, a grey box with To, subject and words, Edit on the left and Send on the right), and below it, outside the card, how far a send got ("Asked to send", "You chose Send", "Sent from …"). Send is the person's own press: main sends the card's words from the account on that press, bound to exactly what the card showed (the press is the approval: no second card). The card then has no Edit or Send, no × and no way to take it back. Where no connected mail account can send (nothing does on a build with no mail connector), the card keeps Open in Mail instead of Send. Only when several accounts can send and none is the default is the account asked, in a plain line above the card with the option chips (the app's own question: a tap fills From and sends nothing to the model). Nothing here sends by itself, and no model tool reaches Send.
import { useState } from 'react';
import { Copy, Mail, X } from 'lucide-react';
import type { DraftNote } from '../../../shared/model/store';
import type { MomoMailAccount } from '../../lib/native/contracts/momoDraft';
import { mailtoOf, readDraft, MAX_BODY } from '../../../shared/momoDraft.mjs';
import { WHY, fromName, sendLines } from '../../../shared/momoDraftSend.mjs';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import { copyText } from '../../session/clipboard';
import { leadWords, sendWords, whyWords } from './draftSendCopy';
import { ChipRow } from './ChipRow';
import { rememberFrom } from './draftLastFrom';
import { useDraftSend } from './useDraftSend';
import styles from './momoDraftCard.module.css';

/** `chatId` and `noteId` name the draft's note in its MoMo chat; without them the card has no Send. */
export function MomoDraftCard({ draft, chatId, noteId }: { draft: DraftNote; chatId?: string; noteId?: string }) {
  const [shown, setShown] = useState(draft);
  const [editing, setEditing] = useState(false);
  const [to, setTo] = useState(draft.to.join(', '));
  const mail = useDraftSend(chatId, noteId);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [line, setLine] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const link = mailtoOf(shown);

  const done = () => {
    const read = readDraft({ to, subject, body });
    if (!read.ok) return setLine({ text: read.why, bad: true });
    setShown(read.draft);
    setEditing(false);
    setLine(null);
  };
  const cancel = () => {
    setTo(shown.to.join(', '));
    setSubject(shown.subject);
    setBody(shown.body);
    setEditing(false);
    setLine(null);
  };
  const open = async () => {
    setBusy(true);
    setLine(null);
    try {
      const r = await native.momoDraft.openInMail(shown);
      if (!r.ok) setLine({ text: r.error, bad: true });
    } catch (e) {
      setLine({ text: errorText(e), bad: true });
    } finally {
      setBusy(false);
    }
  };

  // Send exists in a MoMo chat (a note to name) with an account that can send
  const target = chatId && noteId ? { chatId, noteId } : null;
  const sendNow = async (note: { chatId: string; noteId: string }, from: MomoMailAccount) => {
    setBusy(true);
    setLine(null);
    try {
      const r = await native.momoDraft.send({ ...note, from: from.id, ...shown });
      if (r.send) {
        mail.setSend(r.send);
        rememberFrom(from.id);
      } else if (!r.ok) {
        setLine({ text: whyWords(r.reason, from, r.why), bad: true });
        // the account may be the reason (gone, paused, signed out): read the list again
        if (r.reason !== WHY.BUSY) void mail.reload();
      }
    } catch (e) {
      setLine({ text: errorText(e), bad: true });
    } finally {
      setBusy(false);
    }
  };
  // once a send began the card is read only: the words, and below it the lines of how far it got
  const sent = mail.send;
  const lines = sent ? sendWords(sendLines(sent), sent) : [];
  const from = mail.from;
  const sender = sent ? fromName(sent.from) : from ? fromName(from) : '';
  const canSend = !!target && mail.sendable;

  if (dismissed) return null;
  return (
    <div className={styles.wrap} data-kind="momoDraft">
      <p className={styles.lead}>{leadWords(shown, sender)}</p>
      {target && !sent && mail.needsChoice ? (
        <>
          <p className={styles.lead}>{whyWords(mail.lost ? WHY.LOST : WHY.CHOOSE, null)}</p>
          {/* the draft's own question: a tap fills From (the state the pick sets) and sends nothing to the model */}
          <ChipRow
            label="Send from"
            options={mail.choices.map(fromName)}
            disabled={editing || busy}
            onPick={(_label, i) => mail.pick(mail.choices[i].id)}
          />
        </>
      ) : null}
      <div className={`approval-card ${styles.card}`} role="group" aria-label="Email">
        <div className={styles.top}>
          <span className={styles.icon} aria-hidden="true">
            <Mail size={16} strokeWidth={1.7} />
          </span>
          <span className={styles.spacer} />
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Copy"
            title="Copy"
            onClick={() =>
              copyText(
                shown.body,
                () => setLine({ text: 'Copied', bad: false }),
                () => setLine(null),
              )
            }
          >
            <Copy size={16} strokeWidth={1.7} />
          </button>
          {sent ? null : (
            <button type="button" className={styles.iconBtn} aria-label="Dismiss" title="Dismiss" onClick={() => setDismissed(true)}>
              <X size={16} strokeWidth={1.7} />
            </button>
          )}
        </div>
        <h3 className={styles.title}>Email</h3>
        <dl className={styles.box}>
          <div className={styles.row}>
            <dt>To</dt>
            {editing ? (
              <dd>
                <input className={styles.field} aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
              </dd>
            ) : (
              <dd data-muted data-empty={shown.to.length === 0 || undefined}>
                {shown.to.length ? shown.to.join(', ') : 'No recipient'}
              </dd>
            )}
          </div>
          <div className={styles.row}>
            <dt>Subject</dt>
            {editing ? (
              <dd>
                <input className={styles.field} aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
              </dd>
            ) : (
              <dd data-muted data-empty={!shown.subject || undefined}>
                {shown.subject || 'No subject'}
              </dd>
            )}
          </div>
          <div className={styles.row}>
            {editing ? (
              <textarea
                className={`${styles.field} ${styles.edit}`}
                aria-label="Draft text"
                value={body}
                maxLength={MAX_BODY}
                onChange={(e) => setBody(e.target.value)}
              />
            ) : (
              <p className={styles.body}>{shown.body}</p>
            )}
          </div>
        </dl>
        {sent ? null : (
          <div className={styles.actions}>
            {editing ? (
              <>
                <button type="button" className={styles.secondary} onClick={cancel}>
                  Cancel
                </button>
                <button type="button" className={styles.primary} onClick={done}>
                  Done
                </button>
              </>
            ) : (
              <>
                <button type="button" className={styles.secondary} onClick={() => setEditing(true)}>
                  Edit
                </button>
                {target && mail.sendable ? (
                  from ? (
                    <button type="button" className={styles.primary} disabled={busy} onClick={() => void sendNow(target, from)}>
                      Send
                    </button>
                  ) : (
                    <button type="button" className={styles.primary} disabled>
                      Send
                    </button>
                  )
                ) : (
                  <button type="button" className={styles.primary} disabled={busy || !link.ok} onClick={() => void open()}>
                    Open in Mail
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {lines.length ? (
        <ul className={styles.status} aria-label="Send status">
          {lines.map((text, i) => (
            <li key={text} data-last={i === lines.length - 1 || undefined} data-unsure={sent?.state === 'unsure' || undefined}>
              {text}
            </li>
          ))}
        </ul>
      ) : null}
      {!sent && !editing && !canSend && !link.ok ? <p className={styles.note}>{link.why}</p> : null}
      {line ? (
        <p className={styles.note} data-bad={line.bad || undefined} role={line.bad ? 'alert' : 'status'}>
          {line.text}
        </p>
      ) : null}
    </div>
  );
}
