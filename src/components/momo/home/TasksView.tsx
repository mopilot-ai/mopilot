// MoMo's Tasks as the design draws them (MacTasks, W4.1–W4.7): Needs you / Working / Watching / Done, a detail with done_means, failures with their real cause and one-click fix, Stop, and the empty state.
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { navigate } from '../../../store/panes';
import { groupMomoTasks, type MomoMachineView, type MomoTaskView } from '../../../../shared/momoView';
import { clock, minutesSince } from './homeCopy';
import { Confirm } from './Confirm';
import { Refusal } from './Refusal';
import { probe } from './renderProbe';
import { useNow } from './useNow';
import { useMomoAct } from './useMomoHome';
import styles from './home.module.css';

const GROUP_LABEL: Record<string, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  watching: 'Watching',
  done: 'Done today',
  other: 'Other',
};

/** The one-click fixes a failure offers, by its code (design section 4, "When it fails"). */
function Fixes({ t, machines }: { t: MomoTaskView; machines: MomoMachineView[] }) {
  const { act, busy, failed } = useMomoAct();
  const f = t.failure;
  if (!f) return null;
  const elsewhere = machines.find((m) => m.status === 'online' && m.machineId !== t.where.machine.machineId);
  const retry = (
    <button type="button" key="retry" className={styles.primary} disabled={busy} onClick={() => void act({ type: 'task.retry', id: t.id })}>
      Retry
    </button>
  );
  const other = elsewhere ? (
    <button
      type="button"
      key="other"
      className={styles.btn}
      disabled={busy}
      onClick={() => void act({ type: 'task.runElsewhere', id: t.id, machineId: elsewhere.machineId })}
    >
      {f.code === 'session-error' || f.code === 'retry-cap' || f.code === 'restarted'
        ? 'Run on another machine'
        : `Run on ${elsewhere.name}`}
    </button>
  ) : null;
  const fix = (label: string, id: string) => (
    <button type="button" key="fix" className={styles.primary} disabled={busy} onClick={() => void act({ type: 'fix.run', id })}>
      {label}
    </button>
  );
  // the home's own fix for this cause leads; without one a failed task can be retried
  const primary = f.fix ? fix(f.fix.label, f.fix.id) : f.code === 'machine-unreachable' ? null : retry;
  const buttons = f.code === 'unanswered' ? [primary] : [primary, other];
  return (
    <>
      <p className={styles.error} role="alert">
        {f.message}
      </p>
      <div className={styles.actions}>{buttons}</div>
      <Refusal failed={failed} />
    </>
  );
}

function Detail({ t, machines, now: fixedNow }: { t: MomoTaskView; machines: MomoMachineView[]; now?: number }) {
  const { act, busy, failed } = useMomoAct();
  const [confirm, setConfirm] = useState(false);
  const now = useNow(null, fixedNow);
  const stopButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  // closing the question puts focus back on the button that asked it
  useEffect(() => {
    if (!confirm && restoreFocus.current) stopButton.current?.focus();
    restoreFocus.current = false;
  }, [confirm]);
  return (
    <section className={styles.card} aria-label={t.title}>
      <h2 className={styles.h1}>{t.title}</h2>
      <dl style={{ margin: 0 }}>
        <dt className={styles.meta}>Done means</dt>
        <dd style={{ margin: 0 }}>{t.doneMeans}</dd>
        <dt className={styles.meta}>Where</dt>
        <dd style={{ margin: 0 }}>
          {t.where.agent} · {t.where.machine.name}
        </dd>
        <dt className={styles.meta}>Started</dt>
        <dd style={{ margin: 0 }}>{clock(t.startedAt)}</dd>
        {t.step ? (
          <>
            <dt className={styles.meta}>{t.state === 'watching' ? 'Why' : 'Now'}</dt>
            <dd style={{ margin: 0 }}>{t.step}</dd>
          </>
        ) : null}
        {t.nextCheck ? (
          <>
            <dt className={styles.meta}>Next check</dt>
            <dd style={{ margin: 0 }}>{clock(t.nextCheck)}</dd>
          </>
        ) : null}
      </dl>
      {t.result ? (
        <p className={styles.text}>
          Ready: {t.result.summary}. Checked: {t.result.evidence}.
        </p>
      ) : null}
      <Fixes t={t} machines={machines} />
      {t.state === 'working' && !confirm ? (
        <div className={styles.actions}>
          <button ref={stopButton} type="button" className={styles.btn} disabled={busy} onClick={() => setConfirm(true)}>
            Stop
          </button>
        </div>
      ) : null}
      {confirm ? (
        <Confirm
          title="Stop this task?"
          text="The session stops. Files already made are kept."
          confirm="Stop"
          busy={busy}
          onConfirm={() => void act({ type: 'task.stop', id: t.id }).then((r) => r.ok && setConfirm(false))}
          onCancel={() => {
            restoreFocus.current = true;
            setConfirm(false);
          }}
        />
      ) : null}
      {t.state === 'watching' ? (
        <div className={styles.actions}>
          <button type="button" className={styles.btn} disabled={busy} onClick={() => void act({ type: 'task.stopWatching', id: t.id })}>
            Stop watching
          </button>
        </div>
      ) : null}
      <Refusal failed={failed} />
      <span className={styles.meta}>{minutesSince(t.startedAt, now)} ago</span>
    </section>
  );
}

function lineOf(t: MomoTaskView): string {
  const where = `${t.where.agent} · ${t.where.machine.name}`;
  if (t.state === 'failed') return `${where} · Couldn’t finish`;
  if (t.state === 'stopped') return `${where} · Stopped`;
  return t.step ? `${where} · ${t.step}` : where;
}

const OPEN: Record<string, string> = {
  needs_you: 'Review',
  working: 'Open',
  watching: 'Open',
  done: 'Open',
  failed: 'Open',
  stopped: 'Open',
};

/** One task's row, drawn again only when the task (or whether it is open) changes. */
const TaskRow = memo(function TaskRow({
  t,
  open,
  machines,
  now,
  onToggle,
}: {
  t: MomoTaskView;
  open: boolean;
  machines: MomoMachineView[];
  now?: number;
  onToggle: (id: string) => void;
}) {
  probe(`task:${t.id}`);
  return (
    <li>
      <button type="button" className={styles.row} data-task={t.id} aria-expanded={open} onClick={() => onToggle(t.id)}>
        <span className={styles.rowMain}>
          <span>{t.title}</span>
          <span className={styles.meta}>{lineOf(t)}</span>
        </span>
        <span className={styles.chip}>{OPEN[t.state] ?? 'Open'}</span>
      </button>
      {open ? <Detail t={t} machines={machines} now={now} /> : null}
    </li>
  );
});

export function TasksView({ tasks, machines, now }: { tasks: MomoTaskView[]; machines: MomoMachineView[]; now?: number }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const groups = groupMomoTasks(tasks);
  const toggle = useCallback((id: string) => setOpenId((cur) => (cur === id ? null : id)), []);
  if (!groups.length)
    return (
      <div className={styles.body}>
        <div className={styles.column}>
          <h1 className={styles.h1}>Nothing running.</h1>
          <p className={styles.text}>
            Ask MoMo for something that takes a while. It works in the background and comes back with one result.
          </p>
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={() => navigate({ name: 'momo', tab: 'chat' })}>
              Ask MoMo
            </button>
          </div>
        </div>
      </div>
    );
  return (
    <div className={styles.body}>
      <div className={styles.column}>
        {groups.map((g) => (
          <section key={g.id} aria-label={GROUP_LABEL[g.id]}>
            <h2 className={styles.h2}>
              {GROUP_LABEL[g.id]} {g.tasks.length}
            </h2>
            <ul className={styles.list}>
              {g.tasks.map((t) => (
                <TaskRow key={t.id} t={t} open={t.id === openId} machines={machines} now={now} onToggle={toggle} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
