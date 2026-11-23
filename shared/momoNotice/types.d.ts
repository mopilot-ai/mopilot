// MoMo notice pipeline: the data shapes and the interfaces a Host implements (Google client, version store, notice store, reading model, clock).

/** The three answers an item can get. */
export type Verdict = 'tell_now' | 'track' | 'quiet';

/** A mail as the Google collector hands it over (headers looked up case-insensitively; labels are Gmail label ids). */
export type MailMessage = {
  id: string;
  threadId: string;
  /** As the header reads: `Name <address>` or a bare address. */
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  /** ISO 8601. */
  date: string;
  headers: Record<string, string>;
  labels: string[];
  body: string;
};

/** A Google Calendar event, the fields the notice pipeline reads. */
export type CalendarEvent = {
  id: string;
  etag?: string;
  status: string;
  summary?: string;
  description?: string;
  location?: string;
  updated?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  organizer?: { email?: string; self?: boolean };
  attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
};

/** What Gmail's thread metadata read returns. */
export type ThreadMeta = {
  id: string;
  historyId?: string;
  messages: { id: string; internalDate: string; labelIds?: string[] }[];
};

/**
 * The Google client the Host implements over googleapis (read-only scopes). It owns auth, retries and HTTP; it returns `null`
 * for 404/410 and throws for everything else (429, 5xx, network), so a failed read is never mistaken for "unchanged".
 */
export interface GoogleClient {
  /** Thread ids matching the window (`-in:spam -in:trash`), newest first, one page. */
  listThreads(query: {
    afterMs: number;
    beforeMs: number;
    maxResults: number;
    pageToken?: string;
  }): Promise<{ threadIds: string[]; nextPageToken?: string }>;
  getThreadMeta(threadId: string): Promise<ThreadMeta | null>;
  listEvents(query: {
    timeMin: string;
    timeMax: string;
    showDeleted: true;
    updatedMin?: string;
    maxResults: number;
    pageToken?: string;
  }): Promise<{ events: CalendarEvent[]; nextPageToken?: string }>;
  /** The `etag` of the primary calendar's events collection (`events.list` with `fields=etag`, `maxResults=1`), which changes when an event in it changes; the calendar LIST's etag does not. */
  calendarEtag(): Promise<string>;
}

/** Remembers the last version seen per source key ("gmail:<threadId>", "calendar:<eventId>", "calendar:token"). */
export interface VersionStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, version: string): Promise<void>;
}

/** The home's clock. Injected so nothing here reads `Date.now()`; the time zone is the home's, in `NoticeSettings.timeZone`, never the calling device's. */
export type Clock = { now(): Date };

/** The domains the user has written to or heard from before (from the home's mail history), for the sender check. */
export interface CorrespondentHistory {
  knownDomains(): Promise<string[]>;
}

/** The reading turn's model: text in, text out, no tools by construction (a Host adapter must not attach any). */
export interface ReaderModel {
  readonly name: string;
  complete(prompt: string, signal?: AbortSignal): Promise<string>;
}

/** The typed answer of a reading turn. */
export type ReadingAnswer = { verdict: Verdict; reason: string; matterKey: string };

export type MatterState = 'open' | 'offered' | 'watching' | 'resolved' | 'dismissed';

/** One thing the user may need to act on; a thread is one matter by default. */
export type Matter = {
  matterKey: string;
  state: MatterState;
  title: string;
  summary: string;
  sources: { sourceId: string; id: string; version: string }[];
  /** ISO time the next check is due, for a watching matter. */
  nextCheck?: string;
  /** ISO time of the last tell-now delivery; set once per matter. */
  notifiedAt?: string;
  /** The nearest deadline (a home-local day, YYYY-MM-DD) the user was told about. */
  notifiedDeadline?: string;
  snoozedUntil?: string;
  /** ISO time a "Remind me later" fires, while one waits; and how many times the owner asked (at most three). */
  remindAt?: string;
  reminded?: number;
  /** How many times a due reminder could not be sent (it is given up after three). */
  remindTries?: number;
  /** The urgency (1 plain, 2 within days, 3 today or final) the user was last told at. */
  notifiedUrgency?: 1 | 2 | 3;
  /** The last request or question the user was told about, folded: a different one in a later message re-nudges once. */
  notifiedAsk?: string;
  /** True once a new ask has re-nudged this matter: it happens once. */
  askNudged?: boolean;
  /** The sender failed the check on a money or credential alert: the matter is shown as "may not be from" and never as a genuine alert. */
  suspect?: boolean;
  /** Domain of the sender that started the matter (for the brief and the sender check; the model may merge only into a matter this very thread was filed under). */
  fromDomain?: string;
  /** ISO time after which the matter is over by itself (an event's end). */
  expiresAt?: string;
  /** Held for the brief: told in quiet hours, over the daily cap, held by a snooze, or found on the first connect. */
  pendingDelivery?: 'quiet_hours' | 'daily_cap' | 'snoozed' | 'first_connect';
  /** Set when the matter was last decided, ISO. */
  updatedAt: string;
};

/**
 * The notice state a Host persists. Every method that decides something is atomic in the real store (one transaction): the
 * in-memory store in `memoryStore.ts` is the reference behaviour.
 */
export interface NoticeStore {
  getMatter(key: string): Promise<Matter | undefined>;
  putMatter(matter: Matter): Promise<void>;
  listMatters(): Promise<Matter[]>;
  /** Counts one tell-now toward the home's local `dayKey` only when fewer than `cap` were counted; true when it was counted. The same `key` counts once, so a retry is safe. */
  tryCountTold(dayKey: string, cap: number, key?: string): Promise<boolean>;
  /** True for exactly the first caller of the day: the once-per-day brief claim. */
  claimBrief(dayKey: string): Promise<boolean>;
  /** Gives a claimed day back when the brief could not be shown (delivery failed, the process died before it): the Host calls it so that day can still get its brief. */
  releaseBrief(dayKey: string): Promise<void>;
}
