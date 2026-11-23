// The chat's other cards (the row kinds of shared/momoView.ts): a question with answers to tap, a task's one result card and a watched source that changed. Text from a session is data: drawn as plain text, never a link or an action; the actions on a result are the home's own fix ids.
import type { MomoQuestionView, MomoResultView, MomoWatchChangedView } from '../../../../shared/momoView';
import { clock } from './homeCopy';
import { Refusal } from './Refusal';
import { useNow } from './useNow';
import { useMomoAct } from './useMomoHome';
import styles from './home.module.css';

const RESULT_STATE: Record<string, string> = { done: 'Ready', needs_you: 'Needs you', failed: 'Couldn’t finish' };

export function QuestionCard({ q, now: fixedNow }: { q: MomoQuestionView; now?: number }) {
  const { act, busy, failed } = useMomoAct();
  const now = useNow(q.expiresAt, fixedNow);
  const status = q.status === 'pending' && q.expiresAt !== null && q.expiresAt <= now ? 'expired' : q.status;
  const closed = (title: string, text: string) => (
    <div className={styles.card} role="group" aria-label={q.title} data-status={status} data-testid={`momo-card-${q.id}`}>
      <h3 className={styles.h1}>{title}</h3>
      <p className={styles.text}>{text}</p>
    </div>
  );
  const choice = q.answer?.optionId;
  const chosen = q.options.find((o) => o.id === choice)?.label ?? choice;
  const said = chosen ? `You chose ${chosen}.` : 'Answered.';
  if (status === 'answered') return closed(q.title, said);
  if (status === 'answered-elsewhere')
    return closed(
      `Answered on ${q.answer?.device ? `your ${q.answer.device}` : 'another device'}${q.answer ? ` at ${clock(q.answer.at)}` : ''}`,
      `You chose ${chosen}.`,
    );
  if (status === 'expired') return closed('Expired', 'Nobody answered. Nothing was done.');
  if (status === 'void') return closed('No longer valid', 'MoMo moved, so this question can’t be answered.');
  // a status this client does not know offers no way to answer
  if (status !== 'pending') return closed(q.title, 'Update MoPilot to answer this.');
  return (
    <div className={styles.card} role="group" aria-label={q.title} aria-busy={busy} data-status={status} data-testid={`momo-card-${q.id}`}>
      <h3 className={styles.h1}>{q.title}</h3>
      {q.body ? <p className={styles.text}>{q.body}</p> : null}
      <div className={styles.actions}>
        {q.options.map((o) => (
          <button
            type="button"
            key={o.id}
            className={styles.btn}
            disabled={busy}
            onClick={() => void act({ type: 'question.answer', id: q.id, optionId: o.id })}
          >
            {o.label}
          </button>
        ))}
      </div>
      <Refusal failed={failed} />
    </div>
  );
}

export function ResultCard({ r }: { r: MomoResultView }) {
  const { act, busy, failed } = useMomoAct();
  const state = RESULT_STATE[r.state];
  return (
    <div
      className={styles.card}
      role="group"
      aria-label={r.title}
      aria-busy={busy}
      data-state={r.state}
      data-testid={`momo-card-result-${r.taskId}`}
    >
      <h3 className={styles.h1}>{r.title}</h3>
      <p className={styles.meta}>
        {state ? `${state} · ` : ''}
        {r.machine.name}
      </p>
      <p className={styles.text}>{r.summary}</p>
      {r.files.length ? <p className={styles.text}>{r.files.join(', ')}</p> : null}
      {r.checked ? <p className={styles.meta}>Checked: {r.checked}</p> : null}
      {r.actions.length ? (
        <div className={styles.actions}>
          {r.actions.map((a) => (
            <button
              type="button"
              key={a.id}
              className={styles.btn}
              disabled={busy}
              onClick={() => void act({ type: 'task.act', id: r.taskId, fixId: a.id })}
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
      <Refusal failed={failed} />
    </div>
  );
}

export function WatchChangedCard({ w }: { w: MomoWatchChangedView }) {
  return (
    <div className={styles.card} role="group" aria-label={w.title} data-testid={`momo-card-watch-${w.taskId}`}>
      <h3 className={styles.h1}>{w.title}</h3>
      <p className={styles.text}>{w.detail}</p>
      <p className={styles.meta}>Watching from {w.machine.name}</p>
    </div>
  );
}
