// The deterministic morning brief: structure, counts and order built in code from open matters and the calendar, a "could not check" list, and a once-per-day claim.
import { inQuietHours, localTime, type NoticeSettings } from './limits.ts';
import { cleanText } from './signals.ts';
import type { CalendarEvent, Matter, NoticeStore } from './types.d.ts';

// The brief's shape (needs you, can wait, calendar, could not check, a 50-mail cap that is said out loud) follows OpenDuet's
// openduet/brief.ts (MIT, Copyright (c) 2026 CopilotKit); see THIRD_PARTY.md. A model may word the brief; it cannot change this structure.

/** Mails a brief reads at most; more matching is said under "could not check". */
export const BRIEF_MAIL_CAP = 50;
/** The user must have been active within this many days for a brief to run. */
export const ACTIVE_WITHIN_MS = 7 * 86_400_000;

export type UnsortedItem = { key: string; title: string; error: string };

export type BriefInput = {
  now: Date;
  /** The home's settings: the day key (and so the once-a-day claim) uses `settings.timeZone`, never the calling device's zone. */
  settings: NoticeSettings;
  name: string | null;
  matters: Matter[];
  events: CalendarEvent[];
  /** Items whose reading turn failed: listed as "could not be sorted, so it is here to be safe". */
  unsorted: UnsortedItem[];
  couldNotCheck: { source: string; why: string }[];
  checked: { mail: number; byRules: number; byModel: number };
  /** How many mails matched the window before the cap. */
  mailMatched?: number;
};

export type BriefMatter = { matterKey: string; title: string; summary: string; pending: boolean; suspect: boolean };
export type BriefEvent = { id: string; summary: string; start: string; end: string; location?: string };

export type Brief = {
  dayKey: string;
  at: string;
  name: string | null;
  needsYou: BriefMatter[];
  watching: (BriefMatter & { nextCheck?: string })[];
  today: BriefEvent[];
  couldNotSort: UnsortedItem[];
  couldNotCheck: { source: string; why: string }[];
  checked: BriefInput['checked'];
};

const startOf = (event: CalendarEvent) => event.start?.dateTime ?? event.start?.date ?? '';
const endOf = (event: CalendarEvent) => event.end?.dateTime ?? event.end?.date ?? '';

/** Whether an event begins on the given local day. A date-only event belongs to the day it names. */
function startsOn(event: CalendarEvent, dayKey: string, timeZone: string): boolean {
  const start = startOf(event);
  if (!start) return false;
  return (event.start?.date && !event.start.dateTime ? event.start.date : localTime(new Date(start), timeZone).dayKey) === dayKey;
}

/** Builds the brief. Matters held for quiet hours, the cap or a snooze come first; then the rest by recency; then the key, so the order is total. */
export function buildBrief(input: BriefInput): Brief {
  const { now } = input;
  const timeZone = input.settings.timeZone;
  const { dayKey } = localTime(now, timeZone);
  const asMatter = (matter: Matter): BriefMatter => ({
    matterKey: matter.matterKey,
    title: cleanText(matter.title, 200),
    summary: cleanText(matter.summary, 300),
    pending: matter.pendingDelivery !== undefined,
    suspect: matter.suspect === true,
  });
  const snoozed = (matter: Matter) => matter.snoozedUntil !== undefined && Date.parse(matter.snoozedUntil) > now.getTime();
  const needsYou = input.matters
    .filter((matter) => matter.state === 'open' && !snoozed(matter))
    .sort(
      (a, b) =>
        Number(b.pendingDelivery !== undefined) - Number(a.pendingDelivery !== undefined) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.matterKey.localeCompare(b.matterKey),
    )
    .map(asMatter);
  const watching = input.matters
    .filter((matter) => matter.state === 'watching')
    .sort((a, b) => (a.nextCheck ?? '').localeCompare(b.nextCheck ?? '') || a.matterKey.localeCompare(b.matterKey))
    .map((matter) => ({ ...asMatter(matter), ...(matter.nextCheck ? { nextCheck: matter.nextCheck } : {}) }));
  const today = input.events
    .filter((event) => event.status !== 'cancelled' && startsOn(event, dayKey, timeZone))
    .sort((a, b) => startOf(a).localeCompare(startOf(b)) || a.id.localeCompare(b.id))
    .map((event) => ({
      id: event.id,
      summary: cleanText(event.summary ?? '(no title)', 200),
      start: startOf(event),
      end: endOf(event),
      ...(event.location ? { location: cleanText(event.location, 200) } : {}),
    }));
  const couldNotCheck = input.couldNotCheck.map((gap) => ({ ...gap, source: cleanText(gap.source, 60), why: cleanText(gap.why, 300) }));
  if (input.mailMatched !== undefined && input.mailMatched > BRIEF_MAIL_CAP)
    couldNotCheck.push({
      source: 'Gmail',
      why: `More than ${BRIEF_MAIL_CAP} mails matched, so only the newest ${BRIEF_MAIL_CAP} were read.`,
    });
  return {
    dayKey,
    at: now.toISOString(),
    name: input.name === null ? null : cleanText(input.name, 60),
    needsYou,
    watching,
    today,
    // the caller supplies these: cleaned here too, so no secret, link or control character reaches a brief whatever the caller did
    couldNotSort: input.unsorted.map((item) => ({ ...item, title: cleanText(item.title, 200), error: cleanText(item.error, 200) })),
    couldNotCheck,
    checked: input.checked,
  };
}

/** Whether the brief has anything worth saying. */
export const briefHasContent = (brief: Brief): boolean =>
  brief.needsYou.length + brief.today.length + brief.couldNotSort.length + brief.couldNotCheck.length > 0;

/** `lastBriefAt`: when the Host last showed a brief; a new one within `MIN_BRIEF_GAP_MS` is refused, so changing the home zone cannot send a second brief the same morning. */
export type BriefGate = { enabled: boolean; now: Date; settings: NoticeSettings; lastActiveAt?: Date; lastBriefAt?: Date };

/** The least time between two briefs. */
export const MIN_BRIEF_GAP_MS = 12 * 3_600_000;

/** The standing rule: on, not in quiet hours, and the user was active within 7 days. (Once per day and "something to say" are checked by `runBrief`.) */
export function briefAllowed(gate: BriefGate): { ok: true } | { ok: false; reason: 'off' | 'quiet_hours' | 'inactive' } {
  if (!gate.enabled) return { ok: false, reason: 'off' };
  if (inQuietHours(gate.settings, gate.now)) return { ok: false, reason: 'quiet_hours' };
  if (!gate.lastActiveAt || gate.now.getTime() - gate.lastActiveAt.getTime() > ACTIVE_WITHIN_MS) return { ok: false, reason: 'inactive' };
  return { ok: true };
}

export type BriefRun =
  | { sent: false; reason: 'off' | 'quiet_hours' | 'inactive' | 'nothing_to_say' | 'already_sent' }
  | { sent: true; brief: Brief };

/**
 * Builds today's brief and claims the day with one atomic store call, so a second device only displays it. A quiet day
 * (nothing to say) does not claim the day, so a later pass may still send a brief if something turns up.
 */
export async function runBrief(store: NoticeStore, gate: BriefGate, input: Omit<BriefInput, 'now' | 'settings'>): Promise<BriefRun> {
  const allowed = briefAllowed(gate);
  if (!allowed.ok) return { sent: false, reason: allowed.reason };
  if (gate.lastBriefAt && gate.now.getTime() - gate.lastBriefAt.getTime() < MIN_BRIEF_GAP_MS)
    return { sent: false, reason: 'already_sent' };
  const brief = buildBrief({ ...input, now: gate.now, settings: gate.settings });
  if (!briefHasContent(brief)) return { sent: false, reason: 'nothing_to_say' };
  if (!(await store.claimBrief(brief.dayKey))) return { sent: false, reason: 'already_sent' };
  return { sent: true, brief };
}

/** After the brief was shown: matters it carried count as told, so the once-per-matter rule keeps them quiet. */
export async function markBriefed(store: NoticeStore, brief: Brief, now: Date): Promise<void> {
  for (const item of brief.needsYou) {
    const matter = await store.getMatter(item.matterKey);
    if (!matter) continue;
    const next: Matter = { ...matter, notifiedAt: matter.notifiedAt ?? now.toISOString() };
    delete next.pendingDelivery;
    await store.putMatter(next);
  }
}
