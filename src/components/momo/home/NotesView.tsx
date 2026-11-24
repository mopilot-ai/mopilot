// MoMo's Notes as the design draws them (MacNotes, W2.5–W2.9): a list and a note, each line with its source, "Why MoMo thinks this", edit, history with Undo, forget, empty, and a disconnected source.
import { memo, useState } from 'react';
import type { MomoNoteLine, MomoNoteView, MomoSourceView } from '../../../../shared/momoView';
import { shortDay } from './homeCopy';
import { Confirm } from './Confirm';
import { Refusal } from './Refusal';
import { probe } from './renderProbe';
import { useMomoAct } from './useMomoHome';
import styles from './home.module.css';

const STATUS: Record<string, string> = {
  'mentioned-once': 'Mentioned once',
  learned: 'Learned',
  confirmed: 'Confirmed',
  'let-go': 'Let go',
} as const;
export const SOURCE_NAME: Record<string, string> = { gmail: 'Gmail', calendar: 'Google Calendar' } as const;

const Line = memo(function Line({ noteId, line }: { noteId: string; line: MomoNoteLine }) {
  probe(`line:${line.id}`);
  const { act, busy, failed } = useMomoAct();
  const [why, setWhy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(line.text);
  return (
    <li className={styles.card}>
      <span className={styles.meta}>
        {shortDay(line.at)} · <span className={styles.chip}>{STATUS[line.status] ?? line.status}</span>
      </span>
      {editing ? (
        <>
          <textarea
            ref={(el) => el?.focus()}
            className={styles.field}
            aria-label="Edit line"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <p className={styles.meta}>Your edit becomes Confirmed. The old text stays in History.</p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              disabled={busy || !text.trim()}
              onClick={() => void act({ type: 'note.edit', noteId, lineId: line.id, text }).then((r) => r.ok && setEditing(false))}
            >
              Save
            </button>
            <button type="button" className={styles.btn} onClick={() => (setText(line.text), setEditing(false))}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <p className={styles.text}>{line.text}</p>
      )}
      {line.sources[0] ? <span className={styles.meta}>{line.sources[0].label}</span> : null}
      <div className={styles.actions}>
        {line.sources.length || line.quote ? (
          <button type="button" className={styles.btn} aria-expanded={why} onClick={() => setWhy((w) => !w)}>
            Why MoMo thinks this
          </button>
        ) : null}
        {!editing ? (
          <button type="button" className={styles.btn} onClick={() => setEditing(true)}>
            Edit
          </button>
        ) : null}
      </div>
      {why ? (
        <div role="region" aria-label="Why MoMo thinks this">
          {line.quote ? <blockquote className={styles.quote}>“{line.quote}”</blockquote> : null}
          {line.sources.map((s) => (
            <p key={s.id} className={styles.meta}>
              {s.label} · {shortDay(s.at)}
              {s.gone ? ' · This message is no longer in Gmail. The quote is kept.' : ''}
            </p>
          ))}
        </div>
      ) : null}
      <Refusal failed={failed} />
    </li>
  );
});

function History({ note }: { note: MomoNoteView }) {
  const { act, busy, failed } = useMomoAct();
  return (
    <section className={styles.card} aria-label="History">
      <h3 className={styles.h1}>{note.title} · History</h3>
      <Refusal failed={failed} />
      {note.history.length ? (
        <ul className={styles.list}>
          {note.history.map((c) => (
            <li key={c.id} className={styles.row}>
              <span className={styles.rowMain}>
                <span>{c.summary}</span>
                <span className={styles.meta}>{shortDay(c.at)}</span>
              </span>
              {c.undoable ? (
                <button
                  type="button"
                  className={styles.btn}
                  disabled={busy}
                  onClick={() => void act({ type: 'note.undo', noteId: note.id, changeId: c.id })}
                >
                  Undo
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.meta}>No changes yet.</p>
      )}
      {note.lastChange ? (
        <button type="button" className={styles.btn} disabled={busy} onClick={() => void act({ type: 'note.restore', noteId: note.id })}>
          Restore last night
        </button>
      ) : null}
    </section>
  );
}

function Detail({ note }: { note: MomoNoteView }) {
  const { act, busy, failed } = useMomoAct();
  const [history, setHistory] = useState(false);
  const [forget, setForget] = useState(false);
  const last = note.lastChange;
  return (
    <section aria-label={note.title} className={styles.column}>
      <h2 className={styles.h1}>{note.title}</h2>
      <Refusal failed={failed} />
      <div className={styles.actions}>
        <button type="button" className={styles.btn} aria-expanded={history} onClick={() => setHistory((h) => !h)}>
          History
        </button>
        <button type="button" className={styles.btn} onClick={() => setForget(true)}>
          Forget
        </button>
      </div>
      {forget ? (
        <Confirm
          title="Forget this note? It is deleted, not archived."
          confirm="Forget"
          busy={busy}
          onConfirm={() => void act({ type: 'note.forget', noteId: note.id })}
          onCancel={() => setForget(false)}
        />
      ) : null}
      {last ? (
        <div className={styles.card} role="status">
          <span>Changed last night: {last.summary}</span>
          <div className={styles.actions}>
            <button type="button" className={styles.btn} onClick={() => setHistory(true)}>
              See change
            </button>
            {last.undoable ? (
              <button
                type="button"
                className={styles.btn}
                disabled={busy}
                onClick={() => void act({ type: 'note.undo', noteId: note.id, changeId: last.id })}
              >
                Undo
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {history ? <History note={note} /> : null}
      <ul className={styles.list}>
        {note.lines.map((l) => (
          <Line key={l.id} noteId={note.id} line={l} />
        ))}
      </ul>
    </section>
  );
}

/** What Google ended and what that means, by the home's cause; a cause this version does not know gets the general line. */
const WHY: Record<string, string> = {
  revoked: 'You removed MoMo’s access in Google. Your notes are kept.',
  testing_expired: 'Google’s test sign-in ran out. Your notes are kept.',
  scope_missing: 'Google didn’t give MoMo the access it needs. Your notes are kept.',
  client_rejected: 'Google rejected MoMo’s sign-in settings. Your notes are kept.',
  wrong_account: 'That is not the account MoMo was set up with. Your notes are kept.',
};

function Disconnected({ s }: { s: MomoSourceView }) {
  const { act, busy, failed } = useMomoAct();
  const name = SOURCE_NAME[s.id] ?? s.id;
  return (
    <div className={styles.card} data-tone="warn" role="status" aria-label={`${name} needs you to sign in again`}>
      <h2 className={styles.h1}>{name} needs you to sign in again</h2>
      <Refusal failed={failed} />
      <p className={styles.text}>
        {(s.cause && Object.hasOwn(WHY, s.cause) ? WHY[s.cause] : null) ??
          'Google ended the sign-in. MoMo is not reading new mail. Your notes are kept.'}
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => void act({ type: 'source.reconnect', id: s.id })}>
          Reconnect
        </button>
        <button type="button" className={styles.btn} disabled={busy} onClick={() => void act({ type: 'source.remove', id: s.id })}>
          Remove {name}
        </button>
      </div>
      <p className={styles.meta}>Removing {name} can also forget notes learned only from it.</p>
    </div>
  );
}

function Empty() {
  const { act, failed } = useMomoAct();
  const [writing, setWriting] = useState(false);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  return (
    <div className={styles.column}>
      <h1 className={styles.h1}>Nothing here yet.</h1>
      <Refusal failed={failed} />
      <p className={styles.text}>
        After you connect Gmail and Calendar, MoMo writes down what it learns. You can read and change every line.
      </p>
      {writing ? (
        <form
          className={styles.card}
          onSubmit={(e) => {
            e.preventDefault();
            void act({ type: 'note.write', title: title.trim(), text: text.trim() });
          }}
        >
          <input className={styles.field} aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea className={styles.field} aria-label="Note" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
          <div className={styles.actions}>
            <button type="submit" className={styles.primary} disabled={!title.trim() || !text.trim()}>
              Save
            </button>
            <button type="button" className={styles.btn} onClick={() => setWriting(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={() => void act({ type: 'setup.open' })}>
            Connect Gmail and Calendar
          </button>
          <button type="button" className={styles.btn} onClick={() => setWriting(true)}>
            Write your own note
          </button>
        </div>
      )}
    </div>
  );
}

export function NotesView({ notes: all, sources }: { notes: MomoNoteView[]; sources: MomoSourceView[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const gone = sources.filter((s) => s.status === 'needs-reconnect');
  const notes = all.filter(
    (n) =>
      n.title.toLowerCase().includes(q.trim().toLowerCase()) || n.lines.some((l) => l.text.toLowerCase().includes(q.trim().toLowerCase())),
  );
  const open = all.find((n) => n.id === openId) ?? notes[0];
  return (
    <div className={styles.body}>
      <div className={styles.column}>
        {gone.map((s) => (
          <Disconnected key={s.id} s={s} />
        ))}
        {all.length === 0 ? (
          <Empty />
        ) : (
          <div className={styles.split}>
            <div>
              <input
                className={styles.field}
                type="search"
                aria-label="Search notes"
                placeholder="Search notes"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <ul className={styles.list}>
                {notes.map((n) => (
                  <li key={n.id}>
                    <button type="button" className={styles.row} aria-current={open?.id === n.id} onClick={() => setOpenId(n.id)}>
                      <span className={styles.rowMain}>
                        <span>{n.title}</span>
                        <span className={styles.meta}>{n.kind === 'about' ? 'You wrote this' : `Updated ${shortDay(n.updatedAt)}`}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            {open ? <Detail key={open.id} note={open} /> : <p className={styles.meta}>No notes match.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
