// The Tasks panel's words and times (M0a): short, harness-neutral, one place for the Mac's panel.
import type { MomoPanelTask } from '../../../lib/native/contracts/momoTasks';
import type { MomoRoutineRun } from '../../../lib/native/momoRoutines';
import type { MomoSuggestion } from '../../../lib/native/contracts/momoSuggestions';
import { day } from '../momoDay';

export type TabId = 'active' | 'next' | 'scheduled' | 'resolved';
export const TABS: { id: TabId; label: string }[] = [
  { id: 'active', label: 'Active' },
  { id: 'next', label: 'Up next' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'resolved', label: 'Resolved' },
];

/** What an empty tab says. */
export const EMPTY: Record<TabId, string> = {
  active: 'Nothing needs you.',
  next: 'Nothing queued. Suggestions from your sources show here.',
  scheduled: 'No routines yet.',
  resolved: 'Nothing resolved yet.',
};

/** Why a run did not finish, in a word or two. */
const WHY: Record<string, string> = { stopped: 'Stopped', interrupted: 'Cut short', failed: 'Could not run' };

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;

/** A time as the panel says it: the clock today, else the day and the clock. */
export const when = (ms: number, now: number) => (day(ms) === day(now) ? clock(ms) : `${day(ms)} ${clock(ms)}`);

/** One run in View history: when it started and how it ended. */
export function runLine(r: MomoRoutineRun, now: number): string {
  const how = r.outcome === 'running' ? 'Working' : r.outcome === 'completed' ? 'Finished' : (WHY[r.outcome] ?? 'Did not finish');
  return `${when(r.startedAt, now)} · ${how}`;
}

/** A task's second line. */
export function lineOf(t: MomoPanelTask, now: number): string {
  const parts: (string | null)[] = [];
  // the morning brief: why it could not start or is suspended, else its next time
  if (t.kind === 'brief' && (t.state === 'failed' || t.paused)) parts.push(t.state === 'failed' ? 'Couldn’t start' : null, t.detail);
  else if (t.kind === 'brief') parts.push(t.nextAt === null ? null : `Next ${when(t.nextAt, now)}`);
  // a routine with a run going (its schedule's or the user's Run now), else paused, else its next time
  else if (t.kind === 'routine' && t.at !== null) parts.push('Working', `started ${now - t.at < 60_000 ? 'just now' : when(t.at, now)}`);
  else if (t.kind === 'routine') parts.push(t.paused ? 'Paused' : t.nextAt === null ? null : `Next ${when(t.nextAt, now)}`);
  else if (t.state === 'failed') parts.push(WHY[t.outcome ?? ''] ?? 'Did not finish', t.at === null ? null : when(t.at, now));
  else if (t.state === 'review') parts.push('Ready for review', t.at === null ? null : when(t.at, now));
  else if (t.state === 'running') parts.push('Working');
  else if (t.tab === 'resolved')
    parts.push(
      t.state === 'dismissed' ? 'Dismissed' : t.state === 'archived' ? 'Archived' : 'Done',
      t.at === null ? null : when(t.at, now),
    );
  else {
    if (t.channel) parts.push(`#${t.channel.name}`);
    if (t.dueDay !== null) parts.push(`Due ${t.dueDay}`);
    parts.push(t.detail);
  }
  return parts.filter((s): s is string => !!s).join(' · ');
}

const pct = (n: number) => String(Math.round(n * 100) / 100);

/** What a suggestion was ranked on, in a line: "why did you tell me this?" has this answer beside MoMo's reason. */
export const scoreLine = (s: MomoSuggestion) =>
  `Ranked on: soon ${pct(s.score.urgency)}, cost ${pct(s.score.cost)}, sure ${pct(s.score.confidence)}, new ${pct(s.score.novelty)}.`;
