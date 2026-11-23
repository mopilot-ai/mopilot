// The limits applied after the verdict, in code: quiet hours, the daily cap, one nudge per matter (re-nudged only by a material change), snooze, the watching entry for "track", the first connect, the catch-up summary after sleep, and how matters end.
import type { Matter, NoticeStore, ReadingAnswer } from './types.d.ts';

// The model's answer never overrides these. Quiet-hours and cap defaults follow the design (22:00 to 08:00, 6 a day). The
// wrap-around window arithmetic follows the pattern of gbrain's minions/quiet-hours.ts (MIT, Copyright (c) 2026 Garry Tan);
// see THIRD_PARTY.md. Every day key and every quiet-hours test uses `settings.timeZone`, the HOME's zone: two devices in
// different zones agree on the day, the brief claim and the cap.

export type NoticeSettings = {
  /** The home's IANA time zone: the only zone any day key or quiet-hours test uses. */
  timeZone: string;
  /** Local minutes after midnight; the window may run past midnight. Null, or a start equal to the end, means no quiet hours. */
  quietHours: { startMinute: number; endMinute: number } | null;
  /** Tell-now deliveries a local day may carry. The brief and the catch-up summary do not count. */
  dailyCap: number;
  /** How long after a "track" the next check is due. */
  trackRecheckMs: number;
  /** A gap since the last pass longer than this means the home slept: tell-nows become one summary. */
  catchUpGapMs: number;
};

export const DEFAULT_LIMITS: Omit<NoticeSettings, 'timeZone'> = {
  quietHours: { startMinute: 22 * 60, endMinute: 8 * 60 },
  dailyCap: 6,
  trackRecheckMs: 24 * 3_600_000,
  catchUpGapMs: 2 * 3_600_000,
};

/** The design's defaults on the home's time zone, with any field changed. */
export const noticeSettings = (timeZone: string, changes: Partial<Omit<NoticeSettings, 'timeZone'>> = {}): NoticeSettings => ({
  ...DEFAULT_LIMITS,
  ...changes,
  timeZone,
});

/** The local calendar day ("2026-11-24") and minute of day of an instant in an IANA time zone. */
export function localTime(at: Date, timeZone: string): { dayKey: string; minute: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return { dayKey: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** The instant a local day starts in an IANA time zone. */
export function zonedMidnight(dayKey: string, timeZone: string): Date {
  const utcMidnight = Date.parse(dayKey);
  let guess = utcMidnight;
  // twice: the first pass lands within an hour, the second settles a day whose offset changes
  for (let pass = 0; pass < 2; pass += 1) {
    const local = localTime(new Date(guess), timeZone);
    guess -= Date.parse(local.dayKey) + local.minute * 60_000 - utcMidnight;
  }
  return new Date(guess);
}

export function inQuietHours(settings: NoticeSettings, at: Date): boolean {
  if (!settings.quietHours || settings.quietHours.startMinute === settings.quietHours.endMinute) return false;
  const { startMinute: start, endMinute: end } = settings.quietHours;
  const { minute } = localTime(at, settings.timeZone);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** True when the last pass was so long ago that the home must have slept; false on the first pass (that is the first connect, a different case). */
export const isCatchUp = (lastRunAt: Date | undefined, now: Date, settings: NoticeSettings): boolean =>
  lastRunAt !== undefined && now.getTime() - lastRunAt.getTime() > settings.catchUpGapMs;

export type DeliveryMode = 'normal' | 'catch_up' | 'first_connect';

export type LimitInput = {
  answer: ReadingAnswer;
  matterKey: string;
  title: string;
  source: { sourceId: string; id: string; version: string };
  /** The nearest deadline in the item, as a home-local day. */
  deadline?: string;
  /** 1 plain, 2 within three days, 3 today or final (`urgencyRank`). */
  urgency?: 1 | 2 | 3;
  /** `catch_up`: the home slept, so tell-nows are one summary. `first_connect`: old mail is never pushed, it waits for the brief. */
  mode?: DeliveryMode;
  fromDomain?: string;
  expiresAt?: string;
  /** The first request or question in the item (`askOf`). */
  ask?: string;
  /** The sender failed the check on a money or credential alert: the title says so and the matter is flagged. */
  suspect?: boolean;
};

/** What the pipeline does with an item once the limits ran. */
export type Outcome =
  | { action: 'tell_now'; matterKey: string }
  | { action: 'hold'; matterKey: string; why: 'quiet_hours' | 'daily_cap' | 'snoozed' | 'already_told' | 'dismissed' | 'first_connect' }
  | { action: 'catch_up'; matterKey: string }
  | { action: 'watch'; matterKey: string; nextCheck: string }
  | { action: 'quiet'; matterKey: string };

const iso = (at: Date) => at.toISOString();

/** The matter with this item's newest source recorded. An existing matter keeps its title: another mail's subject never renames it. */
function withSource(existing: Matter | undefined, input: LimitInput, now: Date): Matter {
  const others = (existing?.sources ?? []).filter(
    (source) => !(source.sourceId === input.source.sourceId && source.id === input.source.id),
  );
  const fromDomain = existing?.fromDomain ?? input.fromDomain;
  // built from the record that is there, so a field added to a matter later is carried by default; only what a new mail resets is left out (a held delivery, the flag of an earlier mail)
  const { pendingDelivery: _held, suspect: _flag, ...kept } = existing ?? ({} as Partial<Matter>);
  return {
    ...kept,
    matterKey: input.matterKey,
    state: existing?.state ?? 'open',
    // a suspect mail never renames or rewrites a matter that is already there
    title: existing?.title ?? input.title,
    summary: input.suspect && existing ? existing.summary : input.answer.reason,
    sources: [...others, input.source].slice(-6),
    // the flag belongs to the mail that earned it, on a matter it started: a later genuine mail does not inherit it
    ...(input.suspect && !existing ? { suspect: true } : {}),
    ...(fromDomain ? { fromDomain } : {}),
    ...((input.expiresAt ?? existing?.expiresAt) ? { expiresAt: (input.expiresAt ?? existing?.expiresAt) as string } : {}),
    updatedAt: iso(now),
  };
}

/**
 * Whether an item changes a matter the user was already told about enough to tell them again: the situation got more urgent
 * (today, a final notice) or a nearer deadline than the one they were told appeared. A new message that only continues the thread is not one.
 */
export function isMaterialChange(existing: Matter, input: LimitInput): boolean {
  const escalated = (input.urgency ?? 1) > (existing.notifiedUrgency ?? 1);
  // a deadline where none was told is new information; a nearer one is a change of it
  const nearer = input.deadline !== undefined && (existing.notifiedDeadline === undefined || input.deadline < existing.notifiedDeadline);
  // a different request or question in a later message re-nudges once, however many follow
  const newAsk = input.ask !== undefined && input.ask !== existing.notifiedAsk && existing.askNudged !== true;
  return escalated || nearer || newAsk;
}

/**
 * Applies the limits to one decided item and records the matter. Order: a dismissed matter and a snooze first, then once-per-
 * matter (a material change gets one more), then the first connect, quiet hours, the catch-up summary and the daily cap. The cap is
 * counted only when a tell-now is really delivered. A quiet answer writes nothing: it cannot rename, refresh or silence a matter.
 */
export async function applyLimits(store: NoticeStore, settings: NoticeSettings, now: Date, input: LimitInput): Promise<Outcome> {
  const { matterKey, answer } = input;
  const existing = await store.getMatter(matterKey);
  if (existing?.state === 'dismissed') return { action: 'hold', matterKey, why: 'dismissed' };
  if (answer.verdict === 'quiet') return { action: 'quiet', matterKey };
  const matter = withSource(existing, input, now);

  if (answer.verdict === 'track') {
    const due = now.getTime() + settings.trackRecheckMs;
    const nextCheck = iso(new Date(Math.max(due, existing?.snoozedUntil ? Date.parse(existing.snoozedUntil) : 0)));
    await store.putMatter({ ...matter, state: 'watching', nextCheck });
    return { action: 'watch', matterKey, nextCheck };
  }

  // a tell-now reopens a watching or resolved matter
  const open: Matter = { ...matter, state: matter.state === 'watching' || matter.state === 'resolved' ? 'open' : matter.state };
  const hold = async (why: Extract<Outcome, { action: 'hold' }>['why'], pending?: Matter['pendingDelivery']): Promise<Outcome> => {
    await store.putMatter({ ...open, ...(pending ? { pendingDelivery: pending } : {}) });
    return { action: 'hold', matterKey, why };
  };

  const snoozedUntil = existing?.snoozedUntil ? Date.parse(existing.snoozedUntil) : undefined;
  if (snoozedUntil !== undefined && snoozedUntil > now.getTime()) return hold('snoozed', 'snoozed');
  const snoozeEnded = snoozedUntil !== undefined && existing?.notifiedAt !== undefined && Date.parse(existing.notifiedAt) < snoozedUntil;
  // a resolved matter (replied to, event passed) is over: a new tell-now about it is a new situation
  if (existing?.notifiedAt && existing.state !== 'resolved' && !snoozeEnded && !isMaterialChange(existing, input))
    return hold('already_told');

  if (input.mode === 'first_connect') return hold('first_connect', 'first_connect');
  if (inQuietHours(settings, now)) return hold('quiet_hours', 'quiet_hours');

  const delivered: Matter = { ...open, notifiedAt: iso(now), notifiedUrgency: input.urgency ?? 1 };
  if (input.ask !== undefined) {
    // a changed ask on an already told matter is the one re-nudge a new ask earns
    if (existing?.notifiedAt && input.ask !== existing.notifiedAsk) delivered.askNudged = true;
    delivered.notifiedAsk = input.ask;
  }
  delete delivered.snoozedUntil;
  delete delivered.nextCheck;
  if (input.deadline && (!existing?.notifiedDeadline || input.deadline < existing.notifiedDeadline))
    delivered.notifiedDeadline = input.deadline;

  if (input.mode === 'catch_up') {
    await store.putMatter(delivered);
    return { action: 'catch_up', matterKey };
  }
  const countKey = `${input.source.sourceId}:${input.source.id}:${input.source.version}`;
  if (!(await store.tryCountTold(localTime(now, settings.timeZone).dayKey, settings.dailyCap, countKey)))
    return hold('daily_cap', 'daily_cap');
  await store.putMatter(delivered);
  return { action: 'tell_now', matterKey };
}

/** The user snoozed a matter: nothing about it is delivered before `until`, and it may be told once more after. */
export async function snoozeMatter(store: NoticeStore, matterKey: string, until: Date, now: Date): Promise<boolean> {
  const matter = await store.getMatter(matterKey);
  if (!matter) return false;
  const next: Matter = { ...matter, snoozedUntil: until.toISOString(), updatedAt: now.toISOString() };
  delete next.pendingDelivery;
  await store.putMatter(next);
  return true;
}

/** Ends a matter: the user dismissed it ("Stop watching") and it never raises anything again, or it was resolved (a reply was sent). */
async function endMatter(store: NoticeStore, matterKey: string, state: 'dismissed' | 'resolved', now: Date): Promise<boolean> {
  const matter = await store.getMatter(matterKey);
  if (!matter || matter.state === 'dismissed') return false;
  const next: Matter = { ...matter, state, updatedAt: now.toISOString() };
  delete next.pendingDelivery;
  delete next.nextCheck;
  await store.putMatter(next);
  return true;
}
export const dismissMatter = (store: NoticeStore, matterKey: string, now: Date): Promise<boolean> =>
  endMatter(store, matterKey, 'dismissed', now);
/** The matter is over: the user replied, or its event passed. A later urgent message reopens it. */
export const resolveMatter = (store: NoticeStore, matterKey: string, now: Date): Promise<boolean> =>
  endMatter(store, matterKey, 'resolved', now);

/** How long a live matter may sit without news before it is resolved by itself, so the brief does not grow forever. */
export const MATTER_MAX_AGE_MS = 14 * 86_400_000;

/** Resolves live matters whose event ended or that had no news for `maxAgeMs`; returns their keys. */
export async function sweepMatters(store: NoticeStore, now: Date, maxAgeMs = MATTER_MAX_AGE_MS): Promise<string[]> {
  const swept: string[] = [];
  for (const matter of await store.listMatters()) {
    const live = matter.state === 'open' || matter.state === 'offered' || matter.state === 'watching';
    const over =
      (matter.expiresAt !== undefined && Date.parse(matter.expiresAt) < now.getTime()) ||
      Date.parse(matter.updatedAt) < now.getTime() - maxAgeMs;
    if (live && over && (await resolveMatter(store, matter.matterKey, now))) swept.push(matter.matterKey);
  }
  return swept;
}

/** Watching matters whose next check is due and that are not snoozed: the Host re-reads their sources. */
export async function dueMatters(store: NoticeStore, now: Date): Promise<Matter[]> {
  return (await store.listMatters()).filter(
    (matter) =>
      matter.state === 'watching' &&
      matter.nextCheck !== undefined &&
      Date.parse(matter.nextCheck) <= now.getTime() &&
      !(matter.snoozedUntil && Date.parse(matter.snoozedUntil) > now.getTime()),
  );
}
