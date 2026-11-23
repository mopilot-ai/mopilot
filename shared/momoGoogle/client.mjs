// MoMo's read-only Gmail and Calendar client over googleapis: the `GoogleClient` the notice pipeline implements against, plus the full-message read with caps. Reads stay inside the first-connect windows (30 days of mail before the connect day, no calendar before it, 92 days ahead).
import { calendar as calendarApi } from '@googleapis/calendar';
import { gmail as gmailApi } from '@googleapis/gmail';
import { OAuth2Client } from 'google-auth-library';
import { AccountError } from './account.mjs';
import { delay, GoogleApiError, isRetryable, isScopeProblem, readError } from './errors.mjs';
const DAY_MS = 86_400_000;
export const MAIL_BACK_MS = 30 * DAY_MS;
export const CALENDAR_AHEAD_MS = 92 * DAY_MS;
/** Longest body text handed on, in characters; the rest is cut (the pipeline reads the start of a mail). */
export const BODY_CAP = 20_000;
/** The most of a mail part that is decoded at all (4 characters of cap per character, for UTF-8): a huge part is cut before anything reads it. */
const PART_CAP_BYTES = BODY_CAP * 4;
/** Waits before the 1st, 2nd and 3rd retry of a call that failed for a reason that passes. */
const BACKOFF_MS = [1000, 2000, 4000];
/** The headers handed on: what the pre-checks, the sender check and the reading turn read, nothing else. */
const KEPT_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'reply-to',
  'subject',
  'date',
  'message-id',
  'in-reply-to',
  'references',
  'list-id',
  'list-unsubscribe',
  'precedence',
  'auto-submitted',
  'x-auto-response-suppress',
  'x-autoreply',
]);
const HIDDEN = ['DRAFT', 'SPAM', 'TRASH'];
export const GOOGLE_ENDPOINTS = { gmail: 'https://gmail.googleapis.com/', calendar: 'https://www.googleapis.com/' };
export function createGoogleClient(options) {
  const { account, now, endpoints, timeZone, sleep = delay } = options;
  /**
   * Runs one API call with a fresh token. A 404/410 is `null`. A 401 gets one new access token, and if that is refused too the grant is over (a
   * new sign-in is the cure). A 403 is the grant's fault only when Google says a scope is missing; a rate limit, a 429 and a server error are
   * waited out here (1, 2 then 4 seconds; the HTTP client's own retries are off, so the waits are ours alone) and then thrown. Nothing but a status and a reason ever leaves: the raw error carries the bearer token.
   */
  async function call(run, attempt = 0, renewed = false) {
    const auth = new OAuth2Client();
    const { token, generation } = await account.access();
    auth.setCredentials({ access_token: token });
    try {
      return await run({
        gmail: gmailApi({ version: 'v1', auth, rootUrl: endpoints.gmail, retry: false }),
        calendar: calendarApi({ version: 'v3', auth, rootUrl: endpoints.calendar, retry: false }),
      });
    } catch (e) {
      const failure = readError(e);
      if (failure.status === 404 || failure.status === 410) return null;
      if (failure.status === 401 && !renewed) {
        await account.invalidate(generation);
        return call(run, attempt, true);
      }
      if (failure.status === 401 || isScopeProblem(failure)) {
        const cause = failure.status === 401 ? 'revoked' : 'scope_missing';
        await account.markNeedsSignIn(cause, generation);
        throw new AccountError('needs_sign_in', cause);
      }
      if (isRetryable(failure) && attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt]);
        return call(run, attempt + 1, renewed);
      }
      throw new GoogleApiError(failure.status, failure.reason);
    }
  }
  /** The day of the last sign-in, which bounds what is read; asking first means a source that is not connected fails the usual way. */
  async function connectedAt() {
    await account.accessToken();
    return (await account.load()).connectedAt;
  }
  return {
    async listThreads({ afterMs, beforeMs, maxResults, pageToken }) {
      const connected = await connectedAt();
      const after = Math.max(afterMs, connected - MAIL_BACK_MS);
      const q = `after:${Math.floor(after / 1000)} before:${Math.ceil(beforeMs / 1000)} -in:spam -in:trash`;
      const res = await call(({ gmail }) =>
        gmail.users.threads.list({ userId: 'me', q, maxResults, pageToken, includeSpamTrash: false, fields: 'threads(id),nextPageToken' }),
      );
      return {
        threadIds: (res?.data.threads ?? []).flatMap((t) => (t.id ? [t.id] : [])),
        ...(res?.data.nextPageToken ? { nextPageToken: res.data.nextPageToken } : {}),
      };
    },
    async getThreadMeta(threadId) {
      const res = await call(({ gmail }) =>
        gmail.users.threads.get({
          userId: 'me',
          id: threadId,
          format: 'minimal',
          fields: 'id,historyId,messages(id,internalDate,labelIds)',
        }),
      );
      if (!res) return null;
      return {
        id: res.data.id ?? threadId,
        ...(res.data.historyId ? { historyId: res.data.historyId } : {}),
        messages: (res.data.messages ?? []).map((m) => ({
          id: m.id,
          internalDate: m.internalDate,
          ...(m.labelIds ? { labelIds: m.labelIds } : {}),
        })),
      };
    },
    async listEvents({ timeMin, timeMax, updatedMin, maxResults, pageToken }) {
      const connected = await connectedAt();
      const floor = startOfDayIn(connected, timeZone);
      const min = Math.max(Date.parse(timeMin), floor);
      const max = Math.min(Date.parse(timeMax), now() + CALENDAR_AHEAD_MS);
      if (!(min < max)) return { events: [] };
      const res = await call(({ calendar }) =>
        calendar.events.list({
          calendarId: 'primary',
          timeMin: new Date(min).toISOString(),
          timeMax: new Date(max).toISOString(),
          updatedMin,
          maxResults,
          pageToken,
          singleEvents: true,
          // deleted and cancelled events too: a change is also an event that went away
          showDeleted: true,
        }),
      );
      return {
        events: (res?.data.items ?? []).map(toEvent),
        ...(res?.data.nextPageToken ? { nextPageToken: res.data.nextPageToken } : {}),
        ...(res?.data.etag ? { etag: res.data.etag } : {}),
      };
    },
    async calendarEtag() {
      const res = await call(({ calendar }) =>
        calendar.events.list({ calendarId: 'primary', maxResults: 1, showDeleted: true, fields: 'etag' }),
      );
      if (!res?.data.etag) throw new Error('Google Calendar sent no etag');
      return res.data.etag;
    },
    async getMail(threadId) {
      const res = await call(({ gmail }) => gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' }));
      const visible = (res?.data.messages ?? [])
        .filter((m) => !m.labelIds?.some((l) => HIDDEN.includes(l)))
        .sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
      const m = visible[0];
      if (!m?.id) return null;
      const headers = headerMap(m.payload?.headers ?? []);
      return {
        id: m.id,
        threadId: m.threadId ?? threadId,
        from: headers.from ?? '',
        to: addresses(headers.to),
        cc: addresses(headers.cc),
        subject: headers.subject ?? '',
        date: new Date(Number(m.internalDate)).toISOString(),
        headers,
        labels: m.labelIds ?? [],
        body: bodyText(m.payload).slice(0, BODY_CAP),
      };
    },
  };
}
/**
 * The first instant of the day `ms` falls in, in `timeZone` (the home's own, not UTC): a day with a clock change is 23 or 25 hours long, so the
 * wall clock is read back and corrected once.
 * @param {number} ms @param {string} timeZone
 */
export function startOfDayIn(ms, timeZone) {
  const format = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  /** Seconds since local midnight by the wall clock. @param {number} at */
  const wall = (at) => {
    const p = Object.fromEntries(format.formatToParts(at).map((x) => [x.type, Number(x.value)]));
    return (p.hour * 60 + p.minute) * 60 + p.second;
  };
  const whole = Math.floor(ms / 1000) * 1000;
  const guess = whole - wall(whole) * 1000;
  const off = wall(guess);
  return off === 0 ? guess : guess + (off > 43_200 ? 86_400 - off : -off) * 1000;
}

function toEvent(e) {
  const out = { id: e.id, status: e.status ?? 'confirmed' };
  for (const k of ['etag', 'summary', 'description', 'location', 'updated', 'start', 'end'])
    if (e[k] !== undefined && e[k] !== null) out[k] = e[k];
  if (e.organizer) out.organizer = { email: e.organizer.email, self: e.organizer.self };
  if (e.attendees)
    out.attendees = e.attendees.map((a) => ({
      email: a.email,
      self: a.self,
      responseStatus: a.responseStatus,
    }));
  return out;
}
/** The kept headers by lowercase name, plus Gmail's own `authentication-results` (every value whose authserv-id is mx.google.com, joined with a newline). */
function headerMap(raw) {
  const out = {};
  const auth = [];
  for (const { name, value } of raw) {
    const key = (name ?? '').toLowerCase();
    if (key === 'authentication-results' && value && /^\s*mx\.google\.com\s*[;\s]/i.test(value)) auth.push(value);
    else if (KEPT_HEADERS.has(key) && value !== undefined && value !== null && out[key] === undefined) out[key] = value;
  }
  if (auth.length) out['authentication-results'] = auth.join('\n');
  return out;
}
/** Splits an address header at the commas that are not inside a quoted name or angle brackets. */
function addresses(header) {
  return (header ?? '')
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)(?![^<]*>)/)
    .map((s) => s.trim())
    .filter(Boolean);
}
/** At most `PART_CAP_BYTES` of a base64url mail part, decoded: the cap is applied before anything reads or scans the text. @param {string} data */
const decodePart = (data) => Buffer.from(data.slice(0, Math.ceil(PART_CAP_BYTES / 3) * 4), 'base64url').toString('utf8');

/**
 * The text of an HTML part in one pass: tags, comments and the content of style and script elements are dropped, entities for a space are
 * spaces. Linear in the part's length (no backtracking pattern over it). What the page hid with styles is still in the text, and all of it is
 * mail text: the notice pipeline reads it as untrusted data in its envelope, never as instructions.
 * @param {string} html
 */
export function htmlToText(html) {
  // lower-cased letter by letter so both strings keep the same length (toLowerCase can change it for some characters)
  const lower = html.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    const next = lower[lt + 1] ?? '';
    if (!/[a-z/!]/.test(next)) {
      out += '<';
      i = lt + 1;
      continue;
    }
    out += ' ';
    if (lower.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    const name = /^<(style|script)[\s>/]/.exec(lower.slice(lt, lt + 9))?.[1];
    // the content of a style or script element is not text: skip to its closing tag
    const from = name ? lower.indexOf(`</${name}`, lt) : -1;
    if (name && from === -1) break; // an element that never closes holds the rest of the part
    const gt = html.indexOf('>', from === -1 ? lt : from);
    i = gt === -1 ? html.length : gt + 1;
  }
  return out
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The plain-text body: the first text/plain part, else the first text/html as text. @param {any} payload */
function bodyText(payload) {
  const find = (p, type) => {
    if (!p) return null;
    if (p.mimeType === type && p.body?.data) return decodePart(p.body.data);
    for (const child of p.parts ?? []) {
      const hit = find(child, type);
      if (hit !== null) return hit;
    }
    return null;
  };
  const plain = find(payload, 'text/plain');
  if (plain !== null) return plain;
  const html = find(payload, 'text/html');
  return html === null ? '' : htmlToText(html);
}
