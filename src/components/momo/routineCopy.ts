// What Settings › MoMo › Routines says in plain words (#2139): what a routine is, the empty state, and a schedule main wrote as "Every day at 18" read with a 12-hour clock ("Every day at 6:00 PM"). Only the words change; the rule, its times and the run rules are main's (shared/schedule.mjs, shared/momoRoutine.mjs).

/** One line at the top of the page: what a routine is, where its result goes and that nothing runs before approval. */
export const ROUTINES_INTRO =
  'A routine is something MoMo does on a schedule and tells you about in Chat. Nothing runs until you approve it.';

/** The page with no routine and no proposal: what to ask. */
export const ROUTINES_EMPTY = 'No routines yet. Ask MoMo in Chat to set one up, for example “Brief me every morning at 8”.';

/** What a proposed routine's chip says. */
export const PROPOSED_CHIP = 'Needs your approval';

/** Under a proposal that reads a source that is not connected: what approving does about it. */
export const CONNECT_AFTER_APPROVE = 'Not connected yet. After you approve, connect it here so the routine can read it.';

/**
 * A schedule as main describes it ("Every day at 8", "Every Sunday at 18", "Every day at 10:30") with its one time read on a
 * 12-hour clock ("Every day at 8:00 AM"); anything else (several times, a monthly rule, a rule that did not parse) as main wrote it.
 */
export function whenText(schedule: string): string {
  const m = /^(.* at) (\d{1,2})(?::(\d{2}))?$/.exec(schedule);
  if (!m) return schedule;
  const hour = Number(m[2]);
  const minute = Number(m[3] ?? 0);
  if (hour > 23 || minute > 59) return schedule;
  return `${m[1]} ${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}
