// MoMo's writes to Calendar and Reminders (#2139 P5): create an event, add a reminder, mark one done, and undo one of those. Each is a change through the trust gate: the sentinel decides it by the source's access level (Read only and Blocked never write, Read & ask to change asks on the approval card unless the user remembered that exact action), the audit log records the intent before the helper runs and the outcome after, and the card's one line is built here from the checked arguments (what will be written: title, time, calendar), never from anything the call read. Arguments are normalized (absolute times, trimmed titles) so a remembered approval is bound to exactly that item. What the helper made is kept in the write ledger, so an undo touches only what MoMo wrote and only while it still matches. A write the user's access changed under, or macOS refused, is "not sent"; a helper that timed out or crashed is "uncertain", never retried.
const { SourceError, LABELS } = require('./hub.cjs');
const { timeOf } = require('./calendar.cjs');
const { idsByTitle } = require('./eventKit.cjs');
const { stamp } = require('./tools.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { DETAILS, known } = require('../trustTexts.cjs');

const HOUR = 3_600_000;
const MAX_TITLE = 200;
const MAX_NAME = 100;

/** The source of each tool and what it is, for the sentinel's fingerprint and the card. */
const TOOLS = Object.freeze({
  momo_calendar_create_event: 'calendar',
  momo_reminders_add: 'reminders',
  momo_reminders_complete: 'reminders',
  momo_undo_write: null,
});

/** The gate's reason for a refusal the helper answered, by the SourceError code it became. */
const DETAIL_OF = Object.freeze(
  /** @type {Record<string, string>} */ ({
    not_granted: 'notGranted',
    unavailable: 'helperOld',
    changed: 'changedSince',
    bad_args: 'noSuchTarget',
    read_only: 'readOnlyTarget',
  }),
);

/** Said when a user's Undo may or may not have gone through (the helper stopped answering). */
const UNCERTAIN_UNDO = 'It may or may not have been taken back. Check it in the app.';

const bad = (/** @type {string} */ m) => new SourceError(m, 'bad_args');

/** A required or optional short text, trimmed; one line. */
function textOf(/** @type {unknown} */ v, /** @type {string} */ name, /** @type {number} */ max, required = false) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw bad(`${name} must be text`);
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t) {
    if (required) throw bad(`${name} is required`);
    return undefined;
  }
  if (t.length > max) throw bad(`${name} must be at most ${max} characters`);
  return t;
}

/** The local midnight after a local midnight (a day is 23 or 25 hours across a clock change). */
const nextDay = (/** @type {number} */ midnight) => {
  const d = new Date(midnight);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};
const isDateOnly = (/** @type {unknown} */ v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());

/** @param {any} a an event's arguments, checked and made exact */
function eventArgs(a) {
  const title = /** @type {string} */ (textOf(a.title, 'title', MAX_TITLE, true));
  if (a.start === undefined || a.start === null || a.start === '') throw bad('start is required');
  const start = timeOf(a.start, 0, 'start');
  const allDay = typeof a.allDay === 'boolean' ? a.allDay : isDateOnly(a.start) && (a.end === undefined || isDateOnly(a.end));
  // a timed event lasts an hour unless it says otherwise; an all-day one is one day, and its `end`, a date, is its LAST day
  // (Calendar shows an all-day event through the end of that day), so it is stored as the midnight after it
  const endGiven = a.end !== undefined && a.end !== '';
  const end = !endGiven
    ? allDay
      ? nextDay(start)
      : start + HOUR
    : allDay && isDateOnly(a.end)
      ? nextDay(timeOf(a.end, 0, 'end'))
      : timeOf(a.end, 0, 'end');
  if (end <= start) throw bad('end must be after start');
  const calendar = textOf(a.calendar, 'calendar', MAX_NAME);
  const location = textOf(a.location, 'location', MAX_TITLE);
  return { title, start, end, allDay, ...(calendar && { calendar }), ...(location && { location }) };
}

/** @param {any} a a reminder's arguments, checked and made exact */
function reminderArgs(a) {
  const title = /** @type {string} */ (textOf(a.title, 'title', MAX_TITLE, true));
  const has = a.due !== undefined && a.due !== null && a.due !== '';
  const due = has ? timeOf(a.due, 0, 'due') : undefined;
  const list = textOf(a.list, 'list', MAX_NAME);
  return { title, ...(due !== undefined && { due, dueAllDay: isDateOnly(a.due) }), ...(list && { list }) };
}

/**
 * @param {object} o
 * @param {InstanceType<typeof import('./hub.cjs').SourcesHub>} o.hub
 * @param {ReturnType<typeof import('./eventKit.cjs').createEventKit>} o.eventKit
 * @param {InstanceType<typeof import('./writeLedger.cjs').WriteLedger>} o.ledger
 * @param {ReturnType<typeof import('../trustGate.cjs').createTrustGate>} o.trust
 * @param {Pick<InstanceType<typeof import('../sentinel.cjs').Sentinel>, 'setSource'>} o.sentinel
 * @param {Pick<InstanceType<typeof import('../audit.cjs').AuditLog>, 'available' | 'intent' | 'outcome'>} o.audit the user's own Undo is audited here
 */
function createWriter({ hub, eventKit, ledger, trust, sentinel, audit }) {
  /**
   * One change through the trust gate. `execute` runs only once the sentinel allowed it and the source is still connected
   * at an ask level; what it returns is `{ receipt, value }`.
   * @param {{ source: 'calendar' | 'reminders', tool: string, chatId: string, args: unknown, summary: string, signal?: AbortSignal | null,
   *   execute: () => Promise<{ receipt: string, value?: unknown }> }} c
   */
  async function change({ source, tool, chatId, args, summary, signal = null, execute }) {
    const label = LABELS[source];
    const s = hub.get(source);
    if (!s) throw new SourceError(`${label} isn't connected; the user connects it in Settings › MoMo › Sources`, 'not_connected');
    const scope = await hub.scope(chatId);
    if (scope && !scope.sources.includes(source))
      throw new SourceError(
        `This routine doesn't use ${label}; the user can add it by editing the routine in Settings › MoMo › Routines.`,
        'refused',
      );
    const epoch = hub.epoch(source);
    sentinel.setSource(source, { level: s.level, private: true, name: label });
    const r = await trust(
      { chatId, tool, source, kind: 'change', args, summary },
      async () => {
        // the card may have waited: the source must still be connected, and the user may have changed its level since
        const after = hub.get(source);
        if (!after || hub.epoch(source) !== epoch || after.level !== 'ask' || (await hub.scope(chatId))?.sources.includes(source) === false)
          throw Object.assign(new Error('access changed'), { notSent: true, detail: 'accessChanged' });
        try {
          const out = await execute();
          return { result: 'done', receipt: out.receipt, value: out.value };
        } catch (e) {
          // macOS no longer lets MoMo use it: Settings then shows the source as one to allow again, as a refused read does
          if (e instanceof SourceError && e.code === 'not_granted' && hub.epoch(source) === epoch) hub.markUngranted(source);
          throw withDetail(e);
        }
      },
      { signal },
    );
    if (!r.ok) throw new SourceError(String(r.text), 'refused');
    return { text: String(r.text), value: /** @type {any} */ (r.value) };
  }

  /** A failure the helper answered (nothing written) as the gate's "not sent" with its reason; anything else as it is (uncertain). */
  function withDetail(/** @type {any} */ e) {
    if (!(e instanceof SourceError)) return e;
    const detail = DETAIL_OF[/** @type {string} */ (e.code)];
    return Object.assign(e, { notSent: true, detail });
  }

  /** Takes one written item back in the source: removes what MoMo added, or reopens what it completed, only while it still matches. */
  async function takeBack(/** @type {import('./writeLedger.cjs').Written} */ w) {
    if (w.kind === 'event')
      await eventKit.deleteEvent({ id: w.itemId, expect: { title: w.title, start: /** @type {number} */ (w.start) } });
    else if (w.kind === 'reminder') await eventKit.deleteReminder({ id: w.itemId, expect: { title: w.title } });
    else await eventKit.setReminderDone({ id: w.itemId, done: false, expect: { title: w.title } });
    await ledger.markUndone(w.id).catch((e) => noteIgnored('mark a MoMo write undone', e));
  }

  const keep = async (/** @type {any} */ w) => {
    try {
      const id = await ledger.add(w);
      return id;
    } catch (e) {
      // the write happened; only its undo is lost
      noteIgnored('record a MoMo write in the undo ledger', e);
      return null;
    }
  };
  const undoLine = (/** @type {string | null} */ id) =>
    id ? ` To undo it, call momo_undo_write with id ${id}.` : " It can't be undone from here.";

  return {
    /** @param {any} args @param {string} chatId @param {AbortSignal | null} [signal] */
    async createEvent(args, chatId, signal = null) {
      const a = eventArgs(args);
      // an all-day event reads as its first day, or first to last day; a timed one as its day and hours
      const when = a.allDay
        ? a.end > nextDay(a.start)
          ? `${stamp(a.start, true)} to ${stamp(a.end - 1, true)}`
          : stamp(a.start, true)
        : `${stamp(a.start)}–${stamp(a.end).slice(11)}`;
      const summary = `${a.title} — ${when}${a.calendar ? ` · ${a.calendar}` : ''}`;
      const r = await change({
        source: 'calendar',
        tool: 'momo_calendar_create_event',
        chatId,
        args: a,
        summary,
        signal,
        execute: async () => {
          const calendarId = a.calendar ? idsByTitle(await eventKit.calendars(), [a.calendar], 'calendar')[0] : undefined;
          const made = await eventKit.createEvent({
            title: a.title,
            start: a.start,
            end: a.end,
            allDay: a.allDay,
            ...(calendarId && { calendarId }),
            ...(a.location && { location: a.location }),
          });
          const id = await keep({ kind: 'event', itemId: made.id, title: a.title, start: a.start, chatId });
          return { receipt: 'eventAdded', value: id };
        },
      });
      return `${r.text}${undoLine(r.value)}`;
    },
    /** @param {any} args @param {string} chatId @param {AbortSignal | null} [signal] */
    async addReminder(args, chatId, signal = null) {
      const a = reminderArgs(args);
      const summary = `${a.title}${a.due !== undefined ? ` — due ${stamp(a.due, a.dueAllDay)}` : ''}${a.list ? ` · ${a.list}` : ''}`;
      const r = await change({
        source: 'reminders',
        tool: 'momo_reminders_add',
        chatId,
        args: a,
        summary,
        signal,
        execute: async () => {
          const listId = a.list ? idsByTitle(await eventKit.lists(), [a.list], 'list')[0] : undefined;
          const made = await eventKit.createReminder({
            title: a.title,
            ...(a.due !== undefined && { due: a.due, dueAllDay: a.dueAllDay }),
            ...(listId && { listId }),
          });
          const id = await keep({ kind: 'reminder', itemId: made.id, title: a.title, ...(a.due !== undefined && { due: a.due }), chatId });
          return { receipt: 'reminderAdded', value: id };
        },
      });
      return `${r.text}${undoLine(r.value)}`;
    },
    /** @param {any} args @param {string} chatId @param {AbortSignal | null} [signal] */
    async completeReminder(args, chatId, signal = null) {
      const reminderId = textOf(args.id, 'id', 500, true);
      let found;
      try {
        found = await eventKit.reminder(/** @type {string} */ (reminderId));
      } catch (e) {
        throw e instanceof SourceError && e.code === 'bad_args' ? bad('No reminder has that id; list the reminders to find it.') : e;
      }
      if (found.done) throw bad('That reminder is already done');
      const title = String(found.title).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
      const r = await change({
        source: 'reminders',
        tool: 'momo_reminders_complete',
        chatId,
        args: { id: reminderId, title },
        summary: `${title}${found.list ? ` · ${found.list}` : ''}`,
        signal,
        execute: async () => {
          await eventKit.setReminderDone({ id: /** @type {string} */ (reminderId), done: true, expect: { title: found.title } });
          const id = await keep({ kind: 'complete', itemId: /** @type {string} */ (reminderId), title, chatId });
          return { receipt: 'reminderDone', value: id };
        },
      });
      return `${r.text}${undoLine(r.value)}`;
    },
    /** Undoes one write MoMo made, asked for in a chat (the card asks). @param {any} args @param {string} chatId @param {AbortSignal | null} [signal] */
    async undo(args, chatId, signal = null) {
      const id = textOf(args.id, 'id', 100, true);
      const w = ledger.get(/** @type {string} */ (id));
      if (!w) throw bad('MoMo has no write with that id, or it is older than 30 days');
      if (w.undone !== undefined) throw bad('That write was already undone');
      const source = w.kind === 'event' ? 'calendar' : 'reminders';
      const what = w.kind === 'complete' ? 'Reopen' : 'Remove';
      const r = await change({
        source,
        tool: 'momo_undo_write',
        chatId,
        args: { id },
        summary: `${what} “${w.title}”`,
        signal,
        execute: async () => {
          await takeBack(w);
          return { receipt: 'undone' };
        },
      });
      return r.text;
    },
    /** What MoMo wrote in the last 30 days, newest first, for the Memory tab's list. */
    written() {
      return ledger.list().map((w) => ({
        id: w.id,
        kind: w.kind,
        title: w.title,
        at: w.at,
        ...(w.start !== undefined && { start: w.start }),
        ...(w.due !== undefined && { due: w.due }),
        ...(w.undone !== undefined && { undone: w.undone }),
      }));
    },
    /**
     * The user's own Undo, clicked in the Memory tab: their act, so no card, but audited (intent first, then how it ended) and
     * honest: an item changed since, or a helper that can't delete, is said and left alone. Throws a SourceError with the words
     * the row shows.
     * @param {unknown} id
     */
    async undoByUser(id) {
      const w = ledger.get(String(id));
      if (!w) throw bad('That write is gone or older than 30 days');
      if (w.undone !== undefined) throw bad('That write was already undone');
      const source = w.kind === 'event' ? 'calendar' : 'reminders';
      if (!hub.get(source)) throw new SourceError(`${LABELS[source]} isn't connected`, 'not_connected');
      if (!audit.available()) throw new SourceError("MoMo's audit log can't be written on this Mac, so nothing was changed", 'refused');
      const entry = await audit.intent({ action: 'momo_undo_write', chatId: 'user', args: { id: w.id }, decision: 'user' });
      /** @type {{ result: string, error?: Error }} */
      let ended = { result: 'done' };
      try {
        await takeBack(w);
      } catch (e) {
        const notSent = e instanceof SourceError;
        const detail = notSent ? DETAIL_OF[e.code] : undefined;
        ended = {
          result: notSent ? 'not sent' : 'uncertain',
          error: new SourceError(notSent ? /** @type {string} */ (known(DETAILS, detail)) : UNCERTAIN_UNDO, notSent ? 'refused' : 'failed'),
        };
      }
      await audit.outcome(entry.id, { result: ended.result }).catch((e) => noteIgnored('record how a MoMo undo ended', e));
      if (ended.error) throw ended.error;
    },
  };
}

module.exports = { createWriter, eventArgs, reminderArgs, TOOLS };
