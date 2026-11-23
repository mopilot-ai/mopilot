// The "Runs on <machine>" pill and the Where-MoMo-runs popover (design W1.x): the machines MoMo can live on, Move here / Update / Set up, and what moving costs.
import { useCallback, useEffect, useRef } from 'react';
import { momoHomeTone, type MomoHomeView, type MomoMachineView } from '../../../../shared/momoView';
import { Popover, useAnchor } from '../../ui/Popover';
import { Refusal } from './Refusal';
import { useDialog } from './useDialog';
import { useMomoAct } from './useMomoHome';
import styles from './home.module.css';

/** The pill's words: where MoMo runs, or what is wrong with that. */
export function pillText(home: Pick<MomoHomeView, 'state' | 'machineName' | 'move'>): string {
  const name = home.machineName ?? 'a machine';
  if (home.state === 'asleep') return `${name} is asleep`;
  if (home.state === 'moving') return `Moving to ${home.move?.to.name ?? name}`;
  return `Runs on ${name}`;
}

function Machine({ m, act, busy }: { m: MomoMachineView; act: ReturnType<typeof useMomoAct>['act']; busy: boolean }) {
  const word = m.isHome
    ? 'MoMo is here'
    : m.status === 'needs-update'
      ? 'Update, then move'
      : m.status === 'not-set-up'
        ? 'Set up'
        : m.status === 'offline'
          ? 'Offline'
          : 'Move here';
  const go = () => {
    if (m.status === 'not-set-up') void act({ type: 'machine.setUp', machineId: m.machineId });
    else if (m.status === 'needs-update') void act({ type: 'machine.update', machineId: m.machineId });
    else void act({ type: 'move.start', machineId: m.machineId });
  };
  const note = m.status === 'needs-update' ? 'MoPilot there is out of date' : m.status === 'not-set-up' ? 'Not set up' : m.note;
  return (
    <li className={styles.row}>
      <span className={styles.dot} data-tone={m.status === 'online' ? undefined : 'warn'} aria-hidden />
      <span className={styles.rowMain}>
        <span>{m.name}</span>
        {note ? <span className={styles.meta}>{note}</span> : null}
      </span>
      {m.isHome ? (
        <span className={styles.chip}>{word}</span>
      ) : (
        <button type="button" className={styles.btn} disabled={busy || m.status === 'offline'} onClick={go}>
          {word}
        </button>
      )}
    </li>
  );
}

/** The popover's content: it takes focus when it opens, keeps Tab inside and closes on Escape. */
function Sheet({ home, onClose }: { home: MomoHomeView; onClose: () => void }) {
  const { act, busy, failed } = useMomoAct();
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, onClose);
  return (
    <div ref={ref} role="dialog" aria-label="Where MoMo runs" aria-busy={busy} className={styles.card} style={{ width: 380 }}>
      <h2 className={styles.h1}>Where MoMo runs</h2>
      <ul className={styles.list}>
        {home.machines.map((m) => (
          <Machine key={m.machineId} m={m} act={act} busy={busy} />
        ))}
      </ul>
      <Refusal failed={failed} />
      <p className={styles.meta}>Moving takes about a minute. Notes, rules, tasks and sign-ins move with it.</p>
    </div>
  );
}

export function WhereRuns({ home, open, onOpen }: { home: MomoHomeView; open: boolean; onOpen: (open: boolean) => void }) {
  const a = useAnchor<HTMLButtonElement>();
  const { setOpen } = a;
  const close = useCallback(() => onOpen(false), [onOpen]);
  // the frame's banners open the same popover ("Move MoMo")
  useEffect(() => setOpen(open), [open, setOpen]);
  return (
    <>
      <button type="button" ref={a.ref} className={styles.pill} aria-haspopup="dialog" aria-expanded={open} onClick={() => onOpen(!open)}>
        <span className={styles.dot} data-tone={momoHomeTone(home.state)} aria-hidden />
        {pillText(home)}
      </button>
      <Popover anchor={a.anchor} open={open} onClose={close} placement="bottom-end">
        <Sheet home={home} onClose={close} />
      </Popover>
    </>
  );
}
