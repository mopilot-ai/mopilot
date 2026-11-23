// (shared: main holds a login back until it, the window shows it) The reset time Claude Code prints in its /usage text ("Oct 21 at 5pm", "5pm" in a named zone) as a unix time.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "Oct 21 at 5pm", "Oct 15 at 1:50am", "Jan 2, 2027 at 9am", older ICU's "Oct 15, 1:50am", or a bare "5pm".
const RESET = /^(?:([a-z]{3})[a-z]*\.?[ \t]+(\d{1,2})(?:,[ \t]*(\d{4}))?(?:,|[ \t]+at)?[ \t]+)?(\d{1,2})(?::(\d{2}))?[ \t]*([ap])\.?m\.?$/i;

/** @typedef {{ year: number, month: number, day: number, hour: number, minute: number }} Wall */

/** The wall clock at `ms` in `zone` (this machine's when undefined); throws RangeError for an unknown zone. */
function wallClock(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(ms);
  const n = (type) => Number(parts.find((p) => p.type === type)?.value);
  return { year: n('year'), month: n('month') - 1, day: n('day'), hour: n('hour'), minute: n('minute') };
}

const asUtc = (w) => Date.UTC(w.year, w.month, w.day, w.hour, w.minute);

/** The instant a wall-clock time in `zone` names (ms); in a daylight-saving gap, the instant just after it. */
function instantOf(w, zone) {
  const guess = asUtc(w);
  const first = guess - (asUtc(wallClock(guess, zone)) - guess);
  const second = guess - (asUtc(wallClock(first, zone)) - first);
  // in a gap neither one shows the time asked for: the later is the instant just after it
  return asUtc(wallClock(second, zone)) === guess ? second : Math.max(first, second);
}

/**
 * Unix seconds of a reset the CLI printed in `zone` (the IANA name it adds in parentheses; this machine's
 * when absent), or null when the text is not one it prints. The CLI writes a date without a year in the
 * year it printed it (`printedAt`, ms), and a bare time for a reset within the next day.
 */
export function resetTime(text, zone, printedAt) {
  const m = RESET.exec(text.trim());
  if (!m) return null;
  const tz = zone?.trim() || undefined;
  /** @type {Wall} */
  let now;
  try {
    now = wallClock(printedAt, tz);
  } catch {
    return null; // a zone this runtime doesn't know
  }
  const h = Number(m[4]);
  const minute = Number(m[5] ?? 0);
  if (h < 1 || h > 12 || minute > 59) return null;
  const hour = (h % 12) + (m[6].toLowerCase() === 'p' ? 12 : 0);
  if (!m[1]) {
    // a bare time: its next occurrence
    const today = instantOf({ ...now, hour, minute }, tz);
    const at = today > printedAt ? today : instantOf({ ...now, day: now.day + 1, hour, minute }, tz);
    return Math.floor(at / 1000);
  }
  const month = MONTHS.indexOf(m[1].toLowerCase());
  const day = Number(m[2]);
  const wall = { year: m[3] ? Number(m[3]) : now.year, month, day, hour, minute };
  if (month < 0 || day < 1) return null;
  const at = instantOf(wall, tz);
  // a day the month doesn't have (Feb 30) would roll into the next month
  return wallClock(at, tz).day === day ? Math.floor(at / 1000) : null;
}
