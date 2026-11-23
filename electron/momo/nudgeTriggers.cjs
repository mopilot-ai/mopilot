// When an open loop is worth a nudge (#2139 P4): its due time coming (a lead window before it), a calendar event its `event` words name starting within a day, or not mentioned for STALE_DAYS; each fires once by its key. A loop gets at most MAX_NUDGES nudges (one the model declined doesn't count), then one that asks whether to close it, then none. Pure: the check (nudges.cjs) brings the loops, the events and the time; a date-only due is the end of that day in the user's zone now, so a move across zones moves it with them. Calendar titles are other people's text: they are only matched against the loop's words here, and carried as data, never put in a prompt by this module.
const { dueOf, norm } = require('./openLoopsShape.cjs');

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** The nudges a loop gets before the one that asks whether to close it. */
const MAX_NUDGES = 3;
/** The trigger a nudge the model declined is recorded under. */
const DECLINED = 'declined';
/** How long a loop with no due date goes unmentioned before it is brought up. */
const STALE_DAYS = 14;
/** How long after its due time a due nudge may still come. */
const DUE_GRACE = 12 * HOUR;
/** How far ahead an event may start for its nudge. */
const EVENT_AHEAD = DAY;
/** Words too common to tie an event to a loop. */
const STOP = new Set('a an the and or of to for with at on in my our meeting call event'.split(' '));

/**
 * @typedef {import('./openLoopsShape.cjs').OpenLoop} OpenLoop
 * @typedef {{ title: string, start: number }} CalEvent an event as the Calendar source reads it (start in ms)
 * @typedef {{ loopId: string, trigger: 'due' | 'event' | 'stale' | 'close', key: string, at: number, dueAt?: number,
 *   event?: CalEvent }} Trigger
 */

/** The lead window before a due time: a quarter of the time from saying it to due, at least 2 hours and at most 3 days. */
const leadOf = (/** @type {number} */ saidAt, /** @type {number} */ dueAt) => Math.min(3 * DAY, Math.max(2 * HOUR, (dueAt - saidAt) / 4));

/** The loop's due time now: a date-only due read again in the zone the user is in now; a timed one as kept. */
function dueNow(/** @type {OpenLoop} */ l, /** @type {string} */ tz) {
  if (l.dueDay) return dueOf(l.dueDay, tz, l.saidAt) ?? l.dueAt;
  return l.dueAt;
}

/** The words an event title must share with a loop's `event` (all of them, the common ones aside). */
const eventWords = (/** @type {string} */ t) =>
  norm(t)
    .split(' ')
    .filter((w) => w && !STOP.has(w));

/** The first event starting within EVENT_AHEAD whose title has every one of the loop's event words. */
function matchEvent(/** @type {OpenLoop} */ l, /** @type {CalEvent[]} */ events, /** @type {number} */ now) {
  const want = eventWords(l.event ?? '');
  if (!want.length) return null;
  return (
    events
      .filter((e) => typeof e?.title === 'string' && Number.isFinite(e.start) && e.start > now && e.start <= now + EVENT_AHEAD)
      .sort((a, b) => a.start - b.start)
      .find((e) => {
        const have = new Set(eventWords(e.title));
        return want.every((w) => have.has(w));
      }) ?? null
  );
}

/**
 * The triggers due now, for the open loops that aren't snoozed.
 * @param {OpenLoop[]} loops @param {{ now: number, tz: string, events: CalEvent[] }} o @returns {Trigger[]}
 */
function triggersFor(loops, { now, tz, events }) {
  /** @type {Trigger[]} */
  const out = [];
  for (const l of loops) {
    if (l.state !== 'open' || (l.snoozedUntil ?? 0) > now || l.askedClose !== undefined) continue;
    const fired = new Set(l.nudged.map((n) => n.key));
    // a nudge the model declined spent its trigger but doesn't count toward the loop's nudges
    if (l.nudged.filter((n) => n.trigger !== DECLINED).length >= MAX_NUDGES) {
      if (!fired.has(`close:${l.id}`)) out.push({ loopId: l.id, trigger: 'close', key: `close:${l.id}`, at: now });
      continue;
    }
    const dueAt = dueNow(l, tz);
    if (dueAt !== undefined) {
      const key = `due:${l.id}:${dueAt}`;
      if (!fired.has(key) && now >= dueAt - leadOf(l.saidAt, dueAt) && now < dueAt + DUE_GRACE)
        out.push({ loopId: l.id, trigger: 'due', key, at: now, dueAt });
    }
    const event = l.event ? matchEvent(l, events, now) : null;
    if (event) {
      const key = `event:${l.id}:${event.start}`;
      if (!fired.has(key)) out.push({ loopId: l.id, trigger: 'event', key, at: now, event });
    }
    if (dueAt === undefined && !event) {
      const last = Math.max(l.lastMentionedAt, ...l.nudged.map((n) => n.at));
      if (now - last >= STALE_DAYS * DAY) out.push({ loopId: l.id, trigger: 'stale', key: `stale:${l.id}:${last}`, at: now });
    }
  }
  return out;
}

module.exports = { triggersFor, leadOf, dueNow, matchEvent, DECLINED, MAX_NUDGES, STALE_DAYS, DUE_GRACE, EVENT_AHEAD };
