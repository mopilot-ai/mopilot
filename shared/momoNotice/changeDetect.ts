// Change detection with no model: a version per Gmail thread and per Calendar event, and the one-request calendar probe, so an unchanged item costs nothing.
import { createHash } from 'node:crypto';
import { addDays } from './signals.ts';
import { localTime, zonedMidnight, type NoticeSettings } from './limits.ts';
import type { CalendarEvent, GoogleClient, ThreadMeta, VersionStore } from './types.d.ts';

// Ported from n8n "nod" (src/providers/composio/activity.ts, Apache-2.0, Copyright 2026 n8n GmbH): the hashing and
// filtering rules are theirs; the Composio proxy is replaced by the injected GoogleClient. See THIRD_PARTY.md.

/** Gmail labels that take a message out of the version: it is not mail the user has received. */
const HIDDEN_LABELS = ['DRAFT', 'SPAM', 'TRASH'];

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A thread's version: it changes when a message arrives, is removed, or the user sends one, and ignores label and read-state changes. Null when no visible message is left. */
export function threadVersion(thread: ThreadMeta): string | null {
  const shown = thread.messages
    .filter((message) => !message.labelIds?.some((label) => HIDDEN_LABELS.includes(label)))
    .sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
  if (!shown.length) return null;
  return sha256(shown.map(({ id, internalDate, labelIds }) => ({ id, internalDate, sent: labelIds?.includes('SENT') ?? false })));
}

/** An event's version: a hash of every field the pipeline reads, so any edit changes it. */
export const eventVersion = (event: CalendarEvent): string => sha256(event);

/** The calendar probe's token: the etag plus the home's day, so a quiet calendar is still looked at once a day. */
export const calendarToken = (etag: string, day: string): string => sha256([etag, day]);

export type Change =
  | { kind: 'mail'; threadId: string; version: string }
  | { kind: 'event'; eventId: string; version: string; event: CalendarEvent };

export type DetectOptions = {
  now: Date;
  /** The home's settings: its time zone decides which day "today" is, not the calling device's. */
  settings: Pick<NoticeSettings, 'timeZone'>;
  /** How far back the first look reaches. Default 30 days (nod reads 30 days of mail). */
  windowMs?: number;
  /** Threads read per page. Default 20. */
  pageSize?: number;
  /** The home-local day the account was connected; events before it are never read. */
  connectDay?: string;
};

const DAY_MS = 86_400_000;

/**
 * Threads whose version differs from the one in `store`. It does not write the versions: the caller marks a change seen
 * (`markSeen`) only after the item was decided, so a crash between the two re-reads it instead of losing it.
 */
export async function detectMailChanges(client: GoogleClient, store: VersionStore, options: DetectOptions): Promise<Change[]> {
  const { now, windowMs = 30 * DAY_MS, pageSize = 20 } = options;
  const changes: Change[] = [];
  let pageToken: string | undefined;
  do {
    const page = await client.listThreads({
      afterMs: now.getTime() - windowMs,
      beforeMs: now.getTime() + 1000,
      maxResults: pageSize,
      pageToken,
    });
    for (const threadId of page.threadIds) {
      const thread = await client.getThreadMeta(threadId);
      const version = thread ? threadVersion(thread) : null;
      if (version === null || version === (await store.get(`gmail:${threadId}`))) continue;
      changes.push({ kind: 'mail', threadId, version });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return changes;
}

/** Re-read events updated since the last clean sync, with this much overlap for clock skew. */
const SYNC_OVERLAP_MS = 5 * 60_000;

/**
 * Events whose version differs from the stored one, deleted and cancelled ones included. An unchanged probe token lists nothing;
 * otherwise the window is the home's today through 31 days (never before the connect day) and only events updated since the last
 * clean sync are listed. The caller records the token and the sync time with `markCalendarSynced` only when every event was decided.
 */
export async function detectEventChanges(
  client: GoogleClient,
  store: VersionStore,
  options: DetectOptions,
): Promise<{ changes: Change[]; token: string }> {
  const { now, settings, pageSize = 20 } = options;
  const today = localTime(now, settings.timeZone).dayKey;
  const token = calendarToken(await client.calendarEtag(), today);
  if (token === (await store.get('calendar:token'))) return { changes: [], token };
  const synced = await store.get('calendar:synced');
  const timeMin = zonedMidnight(
    options.connectDay && options.connectDay > today ? options.connectDay : today,
    settings.timeZone,
  ).toISOString();
  const timeMax = zonedMidnight(addDays(today, 31), settings.timeZone).toISOString();
  const updatedMin = synced ? new Date(Date.parse(synced) - SYNC_OVERLAP_MS).toISOString() : undefined;
  const changes: Change[] = [];
  let pageToken: string | undefined;
  do {
    const page = await client.listEvents({
      timeMin,
      timeMax,
      showDeleted: true,
      ...(updatedMin ? { updatedMin } : {}),
      maxResults: pageSize,
      pageToken,
    });
    for (const event of page.events) {
      const version = eventVersion(event);
      if (version !== (await store.get(`calendar:${event.id}`))) changes.push({ kind: 'event', eventId: event.id, version, event });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { changes, token };
}

/** Records that a change was decided, so the next look skips it until it changes again. */
export async function markSeen(store: VersionStore, change: Change): Promise<void> {
  await store.set(change.kind === 'mail' ? `gmail:${change.threadId}` : `calendar:${change.eventId}`, change.version);
}

/** Records the calendar probe token and the sync time once every event it covered was decided (see `calendarClean`). */
export async function markCalendarSynced(store: VersionStore, token: string, now: Date): Promise<void> {
  await store.set('calendar:token', token);
  await store.set('calendar:synced', now.toISOString());
}
