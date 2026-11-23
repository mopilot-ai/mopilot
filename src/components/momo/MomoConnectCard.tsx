// The card a MoMo chat shows when one of its tools needs Calendar or Reminders before the user connected it (a momoConnect card from main's broker, electron/momo/sources/connectAsk.cjs), the same on every harness: the question, one line on what happens next, Connect and Not now. Connect is the same flow as setup's rows and Settings › MoMo › Sources (useSourceConnect.ts): macOS's own prompt, or System Settings when macOS won't ask, with the same lines; main answers the card by itself when the source turns connected, so MoMo goes on with the question. Only a person's click counts.
import type { MomoSourceId } from '../../lib/native/contracts/momoSources';
import { answerSageCard, humanClick } from '../thread/approvals/shared';
import { Calendar, ListChecks, Spinner } from '../ui/icons';
import styles from './momoActionCard.module.css';
import { needsGrant, rowLine } from './sourceConnect';
import { useMomoSource, useSourceConnect } from './useSourceConnect';

const LABEL: Record<'calendar' | 'reminders', string> = { calendar: 'Calendar', reminders: 'Reminders' };
/** What the card says before anything was tried. */
const IDLE = 'MoMo needs it to answer this. It only reads.';

export function MomoConnectCard({ id, source }: { id: string; source: Extract<MomoSourceId, 'calendar' | 'reminders'> }) {
  const label = LABEL[source];
  const { source: row, watching, reload } = useMomoSource(source);
  const c = useSourceConnect({
    id: source,
    label,
    connected: row?.connected === true,
    grantLost: needsGrant(row),
    watching,
    onChanged: reload,
  });
  const line = rowLine({ id: source, phase: c.phase, problem: c.problem, idle: IDLE });
  const inSettings = c.phase === 'needs' || c.phase === 'waiting' || c.phase === 'stalled';
  const Icon = source === 'reminders' ? ListChecks : Calendar;
  const title = `Connect ${label}?`;
  return (
    <div className={`approval-card ${styles.card}`} data-kind="momoConnect" data-phase={c.phase} role="group" aria-label={title}>
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden="true">
          <Icon size={18} strokeWidth={1.7} />
        </span>
        <h3 className={styles.title}>{title}</h3>
      </div>
      <p className={styles.why} data-tone={line.tone} role={line.tone === 'error' ? 'alert' : undefined}>
        {line.waiting && <Spinner size={12} />} {line.desc}
      </p>
      <div className={styles.choices}>
        <button
          type="button"
          className={styles.primary}
          disabled={c.busy}
          onClick={humanClick(() => (inSettings ? c.openSettings() : void c.connect()))}
        >
          {c.phase === 'waiting' ? 'Open again' : inSettings ? 'Open System Settings' : 'Connect'}
        </button>
        <button type="button" className={styles.choice} onClick={humanClick(() => answerSageCard(id, { decision: 'deny' }))}>
          Not now
        </button>
      </div>
    </div>
  );
}
