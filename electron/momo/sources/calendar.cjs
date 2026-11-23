// MoMo's Calendar source (#2139 P2): events in a time range read through the helper's EventKit commands (title, time, location, calendar, attendees' names only), never before the day Calendar was connected (its backfill floor) and at most 92 days at a time; each read is decided and audited by the hub. Connecting asks macOS for access first.
const { SourceError } = require('./hub.cjs');
const { connectWithGrant, idsByTitle, limitOf } = require('./eventKit.cjs');

const DAY = 24 * 60 * 60 * 1000;
/** The longest range one read covers (the helper refuses more). */
const MAX_DAYS = 92;

/** The local day a time falls on, as YYYY-MM-DD (the audit's range reads in the user's own days). */
const localDay = (/** @type {number} */ ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** A time the model gave: an ISO date or time, or milliseconds; `fallback` when it gave none. */
function timeOf(/** @type {unknown} */ v, /** @type {number} */ fallback, /** @type {string} */ name) {
  if (v === undefined || v === null || v === '') return fallback;
  // a bare date is that day's local midnight (Date.parse would read it as UTC); a time without an offset is local already
  const day = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim()) : null;
  const ms = day
    ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime()
    : typeof v === 'number'
      ? v
      : typeof v === 'string'
        ? Date.parse(v)
        : Number.NaN;
  if (!Number.isFinite(ms)) throw new SourceError(`${name} must be an ISO date or time, like 2026-10-23 or 2026-10-23T09:00`, 'bad_args');
  return ms;
}

/**
 * @param {{ hub: InstanceType<typeof import('./hub.cjs').SourcesHub>, eventKit: ReturnType<typeof import('./eventKit.cjs').createEventKit>,
 *           now?: () => number }} o
 */
function calendarSource({ hub, eventKit, now = Date.now }) {
  return {
    id: 'calendar',
    /** Asks macOS for access, then connects: `{ connected, grant }`. */
    connect: () => connectWithGrant(hub, eventKit, 'calendar'),
    /** The calendars' titles, for Settings (the user's own view, not a read by MoMo). */
    detail: async () => (await eventKit.calendars()).map((c) => c.title),
    /**
     * Events overlapping [start, end) (default: the next 7 days), soonest first.
     * @param {{ start?: string | number, end?: string | number, calendars?: string[], limit?: number }} args
     * @param {string} chatId
     */
    async events(args, chatId) {
      let from = timeOf(args.start, now(), 'start');
      const to = timeOf(args.end, from + 7 * DAY, 'end');
      if (to <= from) throw new SourceError('end must be after start', 'bad_args');
      if (to - from > MAX_DAYS * DAY) throw new SourceError(`The range may be at most ${MAX_DAYS} days; read it in parts`, 'bad_args');
      const floor = hub.floor('calendar');
      const clipped = from < floor;
      if (clipped) from = floor;
      // the whole range is before Calendar was connected: nothing there is MoMo's to read
      if (to <= from) return { count: 0, events: [], truncated: false, from, to, clipped, floor };
      // the end is exclusive: the summary names the last day read
      const summary = `events ${localDay(from)} to ${localDay(to - 1)}`;
      // what the read names, for the audit log's digest (#2284)
      const named = { start: from, end: to, calendars: args.calendars, limit: args.limit };
      return hub.read({ source: 'calendar', action: 'calendar.events', chatId, summary, args: named }, async () => {
        const ids = args.calendars?.length ? idsByTitle(await eventKit.calendars(), args.calendars, 'calendar') : undefined;
        const r = await eventKit.events({ start: from, end: to, ...(ids && { ids }), limit: limitOf(args.limit) });
        // EventKit returns events that overlap the range: one that started before the connect day is history, left out
        const events = r.items.filter((/** @type {{ start: number }} */ e) => e.start >= floor);
        return {
          count: events.length,
          events,
          truncated: r.truncated === true,
          from,
          to,
          clipped: clipped || events.length < r.items.length,
          floor,
        };
      });
    },
  };
}

module.exports = { calendarSource, timeOf, MAX_DAYS };
