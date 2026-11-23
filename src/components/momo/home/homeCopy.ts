// The words MoMo's home surfaces show that more than one screen needs, and the clock they print times with.
import type { MOMO_MOVE_STEPS } from '../../../../shared/momoView';

/** A time of day the way the design prints it: 1:12 PM. */
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** A short date: Nov 18. */
export function shortDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** How long since `ms`, in the unit that fits: "3 min", "2 h", "5 d" (at least 1 min). */
export function minutesSince(ms: number, now: number): string {
  const min = Math.max(1, Math.round((now - ms) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

export const MOVE_STEP_LABEL: Record<(typeof MOMO_MOVE_STEPS)[number], string> = {
  paused: 'Paused',
  sealed: 'Sealed',
  copied: 'Copied',
  switching: 'Switching',
  resuming: 'Resuming',
  'cleaning-up': 'Cleaning up',
};

/** "1 person", "2 people". */
export function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The label of a move step; a step this client does not know is shown as it came. */
export function stepLabel(step: string): string {
  return (MOVE_STEP_LABEL as Record<string, string>)[step] ?? step;
}

/** "22:00" as the design prints it: 10:00 PM. */
export function hm12(hm: string): string {
  const [h, m] = hm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
