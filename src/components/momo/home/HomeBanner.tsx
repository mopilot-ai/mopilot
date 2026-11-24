// What the home's state asks of the user, above the page (design W1.1–W1.4, W1.6): moving, move failed or finished late, asleep, out of date, agent signed out or missing. Each says the real cause and carries its one-click fix.
import { useState } from 'react';
import {
  MOMO_MOVE_STEPS,
  momoMoveCancellable,
  type MomoDeliveryProblem,
  type MomoHomeView,
  type MomoMoveView,
} from '../../../../shared/momoView';
import { navigate } from '../../../store/panes';
import { clock, stepLabel } from './homeCopy';
import { Confirm } from './Confirm';
import { Refusal } from './Refusal';
import { useMomoAct } from './useMomoHome';
import styles from './home.module.css';

type Props = { home: MomoHomeView; onMove?: () => void };

/** "Run MoMo here again": the owner takes the home back, after a sheet that says what happens to the copy on the other machine. The copy is the home's own words. */
function Reclaim({ move, sheet }: { move: MomoMoveView; sheet: NonNullable<MomoMoveView['reclaim']> }) {
  const { act, busy, failed } = useMomoAct();
  const [asking, setAsking] = useState(false);
  return (
    <>
      <button type="button" className={styles.btn} disabled={busy} onClick={() => setAsking(true)}>
        Run MoMo here again
      </button>
      {asking ? (
        <Confirm
          title={sheet.title}
          text={sheet.body}
          confirm={sheet.confirm}
          busy={busy}
          onConfirm={() =>
            void act({ type: 'home.reclaim', moveId: move.moveId, toId: move.to.machineId }).then((r) => r.ok && setAsking(false))
          }
          onCancel={() => setAsking(false)}
        />
      ) : null}
      <Refusal failed={failed} />
    </>
  );
}

function Steps({ step }: { step: string }) {
  const at = (MOMO_MOVE_STEPS as readonly string[]).indexOf(step);
  return (
    <ol className={styles.steps} aria-label="Move progress">
      {MOMO_MOVE_STEPS.map((s, i) => (
        <li key={s} data-state={i < at ? 'done' : i === at ? 'now' : 'next'} aria-current={i === at ? 'step' : undefined}>
          {stepLabel(s)}
        </li>
      ))}
    </ol>
  );
}

export function HomeBanner({ home, onMove }: Props) {
  const { act, busy, failed } = useMomoAct();
  const name = home.machineName ?? 'MoMo’s machine';
  const wrap = (title: string, text: string, tone: 'warn' | undefined, buttons: React.ReactNode, extra?: React.ReactNode) => (
    <div className={styles.card} data-tone={tone} role="status" aria-label={title}>
      <h2 className={styles.h1}>{title}</h2>
      <p className={styles.text}>{text}</p>
      {extra}
      <div className={styles.actions}>{buttons}</div>
      {busy ? (
        <span className={styles.meta} role="status">
          Working…
        </span>
      ) : null}
      <Refusal failed={failed} />
    </div>
  );
  const btn = (label: string, a: Parameters<typeof act>[0], primary = false) => (
    <button type="button" key={label} className={primary ? styles.primary : styles.btn} disabled={busy} onClick={() => void act(a)}>
      {label}
    </button>
  );
  const m = home.move;
  if (m?.failure)
    return wrap(
      'Move didn’t finish',
      `${m.failure.cause} MoMo is still on ${m.from.name}. Nothing was lost.`,
      'warn',
      [
        btn('Retry', { type: 'move.retry' }, true),
        btn(`Stay on ${m.from.name}`, { type: 'move.stay' }),
        ...(m.reclaim ? [<Reclaim key="reclaim" move={m} sheet={m.reclaim} />] : []),
      ],
      <>
        <p className={styles.meta}>Last step reached: {stepLabel(m.failure.failedAt)}</p>
      </>,
    );
  if (m?.outcome === 'moved' && m.oldMachineOffline)
    return wrap(`Moved to ${m.to.name}`, `${m.from.name} is offline and still holds a copy. It clears itself when it is back.`, undefined, [
      btn('Got it', { type: 'move.dismiss' }),
    ]);
  // a move that finished (moved or cancelled) and needs nothing from the user is over: the pill already says where MoMo runs
  const over = m?.outcome === 'moved' || m?.outcome === 'cancelled';
  if (m && over && m.reclaim)
    return wrap(`Moved to ${m.to.name}`, `MoMo runs on ${m.to.name} now.`, undefined, [
      <Reclaim key="reclaim" move={m} sheet={m.reclaim} />,
    ]);
  if (m && !over)
    return wrap(
      `Moving MoMo to ${m.to.name}`,
      'Chat and the morning brief wait until it is done. Your messages are kept.',
      undefined,
      [
        ...(momoMoveCancellable(m.step) ? [btn('Cancel', { type: 'move.cancel' })] : []),
        ...(m.reclaim ? [<Reclaim key="reclaim" move={m} sheet={m.reclaim} />] : []),
      ],
      <>
        <p className={styles.meta}>From {m.from.name} · about a minute</p>
        <Steps step={m.step} />
        {momoMoveCancellable(m.step) ? <p className={styles.meta}>You can cancel until the switch.</p> : null}
      </>,
    );
  if (home.movedAway)
    return wrap(
      `MoMo moved to ${home.movedAway.machine.name} at ${clock(home.movedAway.at)}.`,
      'This Mac holds no MoMo data.',
      undefined,
      <button type="button" key="open" className={styles.btn} onClick={() => navigate({ name: 'settings', section: 'connections' })}>
        Open {home.movedAway.machine.name}
      </button>,
    );
  if (home.state === 'asleep')
    return wrap(
      `MoMo’s home went to sleep${home.stateSince ? ` at ${clock(home.stateSince)}` : ''}`,
      'Nothing is being checked. Your messages wait here.',
      'warn',
      [
        btn(`Wake ${name}`, { type: 'home.wake' }, true),
        <button type="button" key="move" className={styles.btn} onClick={onMove}>
          Move MoMo
        </button>,
      ],
    );
  if (home.state === 'needs-update')
    return wrap(
      `MoPilot on ${name} is out of date`,
      'It can’t take new work until it is updated. Your notes are safe.',
      'warn',
      [
        btn(`Update ${name}`, { type: 'machine.update', machineId: home.homeMachineId ?? '' }, true),
        <button type="button" key="move" className={styles.btn} onClick={onMove}>
          Move MoMo instead
        </button>,
      ],
      <p className={styles.meta}>
        {home.update ? `${name} has ${home.update.have}; it needs ${home.update.need}. ` : ''}Takes about a minute. MoPilot restarts on{' '}
        {name}.
      </p>,
    );
  if (home.state === 'needs-sign-in') {
    const p = home.agentProblem;
    const missing = p?.kind === 'not-installed';
    return wrap(
      missing ? `${p.agent} isn’t installed on ${name}` : `${p?.agent ?? 'The agent'} is signed out on ${name}`,
      missing
        ? 'MoMo can’t think until an agent is installed. It still notes mail and calendar changes.'
        : 'MoMo can’t think until it is signed in. It still notes mail and calendar changes.',
      'warn',
      [
        btn(p?.fix.label ?? `Sign in on ${name}`, { type: 'fix.run', id: p?.fix.id ?? '' }, true),
        btn('Use another agent', { type: 'home.useOtherAgent' }),
      ],
      <p className={styles.meta}>
        {missing ? 'The install happens on ' + name + '.' : `The sign-in happens on ${name}. Your password never goes to MoMo.`}
      </p>,
    );
  }
  return null;
}

/** Problems delivering the brief or notifications: each says its cause as the home worded it, with its one-click fix. */
export function ProblemBanners({ problems }: { problems: MomoDeliveryProblem[] }) {
  const { act, busy, failed } = useMomoAct();
  return (
    <>
      <Refusal failed={failed} />
      {problems.map((p) => (
        <div key={p.id} className={styles.card} data-tone="warn" role="status">
          <p className={styles.text}>{p.cause}</p>
          <div className={styles.actions}>
            <button type="button" className={styles.btn} disabled={busy} onClick={() => void act({ type: 'fix.run', id: p.fix.id })}>
              {p.fix.label}
            </button>
            {(p.also ?? []).map((f) => (
              <button
                key={f.id}
                type="button"
                className={styles.btn}
                disabled={busy}
                onClick={() => void act({ type: 'fix.run', id: f.id })}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
