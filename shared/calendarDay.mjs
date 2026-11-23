// Today and the dates a browser result names, as an agent is told them: the weekday, the local date, its ISO week and how many days each date is from today, so "this week" and "within 30 days" need no calendar reckoning by the model (#1381 stab1).

const DAY_MS = 86_400_000;
/** At most this many distinct dates of one result are placed. */
const DATES_MAX = 20;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH =
  '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
/** 2026-10-08, Oct 8, 2026 / October 8 2026, 8 Oct 2026: the forms a record's dates take with their year. */
const DATE_RE = new RegExp(
  `(?<![\\w-])(\\d{4})-(\\d{2})-(\\d{2})(?![\\w-])|(?<!\\w)${MONTH} (\\d{1,2}),? (\\d{4})(?!\\w)|(?<!\\w)(\\d{1,2}) ${MONTH},? (\\d{4})(?!\\w)`,
  'gi',
);

/** The ISO 8601 week number of a calendar date (weeks start on Monday; week 1 holds the year's first Thursday). */
export function isoWeek(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  const weekday = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - jan1) / DAY_MS + 1) / 7);
}

/**
 * Today's calendar day in a time zone.
 * @param {Date} [now]
 * @param {string} [timeZone] an IANA zone; the system's when left out
 * @returns {{ year: number, month: number, day: number, weekday: string, week: number, timeZone: string }}
 */
export function calendarNow(now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const [year, month, day] = [Number(parts.year), Number(parts.month), Number(parts.day)];
  return { year, month, day, weekday: parts.weekday, week: isoWeek(year, month, day), timeZone };
}

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** The Monday-to-Sunday week `back` weeks before the one that holds the date, as its first and last day. */
function weekOf(cal, back = 0) {
  const at = Date.UTC(cal.year, cal.month - 1, cal.day);
  const monday = at - ((new Date(at).getUTCDay() + 6) % 7) * DAY_MS - back * 7 * DAY_MS;
  const day = (t) => {
    const d = new Date(t);
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  };
  return [day(monday), day(monday + 6 * DAY_MS)];
}

/**
 * "Today is Sunday, 2026-11-08 (ISO week 45, UTC). This week is 2026-11-02 to 2026-11-08 (Monday to Sunday); last week was
 * 2026-10-26 to 2026-11-01." The weeks are named, not only numbered: on a Sunday two G12 runs took the week that ends today for
 * "the calendar week before this one" (#3571).
 */
export const todayLine = (cal = calendarNow()) => {
  const [first, last] = weekOf(cal);
  const [before, beforeLast] = weekOf(cal, 1);
  return `Today is ${cal.weekday}, ${iso(cal.year, cal.month, cal.day)} (ISO week ${cal.week}, ${cal.timeZone}). This week is ${first} to ${last} (Monday to Sunday); last week was ${before} to ${beforeLast}.`;
};

/** Each real calendar date the text names, once, in order, as [y, m, d]. */
function datesIn(text) {
  const seen = new Map();
  for (const m of text.matchAll(DATE_RE)) {
    const [y, mo, d] = m[1]
      ? [m[1], m[2], m[3]]
      : m[4]
        ? [m[6], MONTHS.indexOf(m[4].slice(0, 3).toLowerCase()) + 1, m[5]]
        : [m[9], MONTHS.indexOf(m[8].slice(0, 3).toLowerCase()) + 1, m[7]];
    const [year, month, day] = [Number(y), Number(mo), Number(d)];
    const at = new Date(Date.UTC(year, month - 1, day));
    if (at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) continue;
    seen.set(iso(year, month, day), [year, month, day]);
  }
  return [...seen.values()];
}

const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

/**
 * The note placed after a browser tool's result when its text names dates: today, then how far each date is from it,
 * or [] when it names none. The page text itself is never changed.
 * @param {Array<{ type: string, text?: string }>} items the tool's own result content
 */
export function datesNote(items, cal = calendarNow()) {
  // the line naming today (browser_tabs_context's) is no date the result names
  const text = items
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('\n')
    .replaceAll(todayLine(cal), '');
  const found = datesIn(text);
  if (!found.length) return [];
  const today = Date.UTC(cal.year, cal.month - 1, cal.day);
  const placed = found.slice(0, DATES_MAX).map(([y, m, d]) => {
    const n = Math.round((Date.UTC(y, m - 1, d) - today) / DAY_MS);
    return `${iso(y, m, d)}: ${n === 0 ? 'today' : n < 0 ? `${days(-n)} ago` : `in ${days(n)}`}`;
  });
  const more = found.length > DATES_MAX ? ` (and ${found.length - DATES_MAX} more)` : '';
  return [{ type: 'text', text: `<dates>\n${todayLine(cal)}\n${placed.join(' · ')}${more}\n</dates>` }];
}
