// The scheduled tasks the Mac lists for a phone (read only): name and next run.
import { bad, capabilities, list, rec, str, num, type Capabilities, type Owned } from './client';
import type { Machine } from './machines';

/** `hostId` is the machine the Mac says a task runs on (an account with Host only); null for this Mac's own. */
export type ScheduledTask = { id: string; name: string; next: number | null; hostId: string | null };

/** The tasks soonest first as the Mac sent them, or the message to update a Mac that cannot list them. */
export async function loadScheduled(request: Owned): Promise<{ tasks: ScheduledTask[] } | { old: string }> {
  const caps = await capabilities(request).catch((): Capabilities => ({ methods: null, ceiling: 'auto-review' }));
  if (caps.methods && !caps.methods.has('scheduled.list'))
    return { old: 'Update MoPilot on your computer to see scheduled tasks from your phone.' };
  const r = rec(await request('scheduled.list'));
  if (!r || !Array.isArray(r.tasks)) return bad('the scheduled tasks');
  return {
    tasks: list(r.tasks).flatMap((x) => {
      const t = rec(x);
      const id = str(t?.id);
      return id ? [{ id, name: str(t?.name) ?? id, next: num(t?.next), hostId: str(t?.hostId) }] : [];
    }),
  };
}

/** When a task runs next: soon as a countdown, later as a day and time, and none as "No upcoming run". */
export function nextRunLine(next: number | null, now: number): string {
  if (next === null) return 'No upcoming run';
  const minutes = Math.ceil((next - now) / 60_000);
  if (minutes <= 0) return 'Due now';
  if (minutes < 60) return `In ${minutes} min`;
  if (minutes < 24 * 60) return `In ${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  const at = new Date(next);
  return `${at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

/**
 * A task's grey line: when it runs next, then the machine it runs on when it is not this Mac's own. The name is the one the Chats
 * list gives that machine; a machine the phone cannot name (not listed, or no list yet) adds nothing.
 */
export function taskLine(task: ScheduledTask, machines: Machine[] | null, now: number): string {
  const host = task.hostId && task.hostId !== 'local' ? machines?.find((m) => m.id === task.hostId)?.name : null;
  return [nextRunLine(task.next, now), host].filter(Boolean).join(' · ');
}
