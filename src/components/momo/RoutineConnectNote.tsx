// A line under an approved routine in Settings › MoMo › Routines when a source it reads (Calendar or Reminders) is not connected (#2999): the routine runs on its own, so it would find nothing there. It offers the same Connect as the chat's connect card and setup's rows (useSourceConnect.ts), and goes away once the source is connected.
import type { MomoSourceId } from '../../lib/native/contracts/momoSources';
import { CONNECT_AFTER_APPROVE } from './routineCopy';
import { needsGrant, rowLine } from './sourceConnect';
import styles from './routinesList.module.css';
import { useMomoSource, useSourceConnect } from './useSourceConnect';

const LABEL: Record<'calendar' | 'reminders', string> = { calendar: 'Calendar', reminders: 'Reminders' };
/** The sources macOS asks for; Files needs a folder, added in Settings › MoMo › Sources. */
export const CONNECTABLE = ['calendar', 'reminders'] as const;

export function RoutineConnectNote({ source }: { source: Extract<MomoSourceId, 'calendar' | 'reminders'> }) {
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
  // not read yet, or connected and allowed by macOS: nothing to say
  if (!row || (row.connected && !needsGrant(row))) return null;
  const line = rowLine({
    id: source,
    phase: c.phase,
    problem: c.problem,
    idle: `${label} isn’t connected. This routine can’t read it yet.`,
  });
  const inSettings = c.phase === 'needs' || c.phase === 'waiting' || c.phase === 'stalled';
  return (
    <p className={styles.note} data-tone={line.tone}>
      <span>{line.desc}</span>
      <button type="button" className="btn sm" disabled={c.busy} onClick={() => (inSettings ? c.openSettings() : void c.connect())}>
        {c.phase === 'waiting' ? 'Open again' : inSettings ? 'Open System Settings' : 'Connect'}
      </button>
    </p>
  );
}

/**
 * Under a proposal that reads Calendar or Reminders: when one of them is not connected (or macOS refuses it), what approving does
 * about it. A proposal has no Connect of its own; the approved routine gets RoutineConnectNote.
 */
export function ProposalConnectNote({ ids }: { ids: string[] }) {
  const calendar = useMomoSource('calendar').source;
  const reminders = useMomoSource('reminders').source;
  const ready = (row: typeof calendar) => row !== null && row.connected && !needsGrant(row);
  const missing = (ids.includes('calendar') && !ready(calendar)) || (ids.includes('reminders') && !ready(reminders));
  return missing ? <p className={styles.note}>{CONNECT_AFTER_APPROVE}</p> : null;
}
