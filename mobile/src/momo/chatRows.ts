// MoMo's one continuous chat as rows to draw: the transcript's messages, reminders as their own cards, and a dotted day line where the day changes.
import { displayRows, keyedRows, type Row, type Thread, type Data } from '../presentation/thread';
import { nudgeOf, type Nudge } from './stateContract';

export type MomoRow =
  | { kind: 'message'; key: string; row: Row & { key: string } }
  | { kind: 'nudge'; key: string; nudge: Nudge }
  | { kind: 'day'; key: string; label: string };

/** "Today", "Yesterday", else the weekday and date, as Claude's Dispatch heads each day. */
export function dayLabel(at: number, now: number): string {
  const day = (ms: number) => new Date(ms).toDateString();
  if (day(at) === day(now)) return 'Today';
  if (day(at) === day(now - 86_400_000)) return 'Yesterday';
  return new Date(at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Reconciled rows retain their own reminder and timestamp, including when live items are inserted before saved rows.
 */
export function momoRows(thread: Thread, now: number): MomoRow[] {
  const rows = keyedRows(displayRows(thread));
  const out: MomoRow[] = [];
  let lastDay: string | null = null;
  rows.forEach((row) => {
    const raw = row as Row & Data;
    const at = typeof raw?.at === 'number' && Number.isFinite(raw.at) ? raw.at : null;
    if (at !== null) {
      const label = dayLabel(at, now);
      if (label !== lastDay) out.push({ kind: 'day', key: `day:${row.key}`, label });
      lastDay = label;
    }
    const nudge = raw ? nudgeOf(raw) : null;
    out.push(nudge ? { kind: 'nudge', key: `nudge:${nudge.loopId}`, nudge } : { kind: 'message', key: row.key, row });
  });
  return out;
}
