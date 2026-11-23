// Wall-clock arithmetic for MoMo's home (S6/S7): the user's day, minute of day and quiet hours read on one IANA zone, so a brief at 8:00 and a quiet window mean the same on a Host in another zone, across daylight saving and after the owner changes zone.

/** The zone this Host's own clock runs on. */
export const hostZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** @type {Map<string, Intl.DateTimeFormat>} */
const formats = new Map();

/** @param {string} zone @returns {Intl.DateTimeFormat | null} null when the zone is not one the platform knows */
function formatOf(zone) {
  let f = formats.get(zone);
  if (f) return f;
  try {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return null;
  }
  formats.set(zone, f);
  return f;
}

/**
 * The day ("2026-11-23") and minute of that day (0-1439) at `ms` on `zone`; an unknown zone reads on this Host's own.
 * @param {number} ms @param {string} [zone]
 * @returns {{ day: string, minutes: number, zone: string }}
 */
export function zonedParts(ms, zone = hostZone()) {
  const f = formatOf(zone);
  const use = f ? zone : hostZone();
  const parts = /** @type {Intl.DateTimeFormat} */ (f ?? formatOf(use)).formatToParts(ms);
  const get = (/** @type {string} */ type) => /** @type {Intl.DateTimeFormatPart} */ (parts.find((p) => p.type === type)).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')), zone: use };
}

/** "HH:MM" as minutes after midnight, or null. @param {unknown} v */
export function clockMinutes(v) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(typeof v === 'string' ? v.trim() : '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Whether minute-of-day `minutes` is inside quiet hours (which may run past midnight); none given is never quiet.
 * @param {{ start: number, end: number } | null | undefined} quiet @param {number} minutes
 */
export function minuteInQuiet(quiet, minutes) {
  if (!quiet || quiet.start === quiet.end) return false;
  return quiet.start < quiet.end ? minutes >= quiet.start && minutes < quiet.end : minutes >= quiet.start || minutes < quiet.end;
}

/** @param {{ start: number, end: number } | null | undefined} quiet @param {number} ms @param {string} [zone] */
export const inQuiet = (quiet, ms, zone) => minuteInQuiet(quiet, zonedParts(ms, zone).minutes);

const MINUTE = 60_000;

/**
 * When quiet hours end if `ms` is inside them, else null: the first whole minute on the zone's clock that is outside them, found by stepping
 * the real clock, so a day that gains or loses an hour (daylight saving) still ends at the wall time named.
 * @param {{ start: number, end: number } | null | undefined} quiet @param {number} ms @param {string} [zone]
 */
export function quietEndsAt(quiet, ms, zone) {
  if (!inQuiet(quiet, ms, zone)) return null;
  // at most a whole day and an hour (a repeated hour) of quiet: stepping a minute at a time is exact and cheap
  let t = Math.floor(ms / MINUTE) * MINUTE;
  for (let i = 0; i < 25 * 60; i++) {
    t += MINUTE;
    if (!inQuiet(quiet, t, zone)) return t;
  }
  return t;
}

/**
 * The first instant after `ms` at which the wall clock of `zone` reads `minutes` after midnight (a "remind me at 4" with no day named); a time the day does not have (daylight saving) is the next minute that exists.
 * @param {number} minutes @param {number} ms @param {string} [zone]
 */
export function nextWallTime(minutes, ms, zone) {
  let t = Math.floor(ms / MINUTE) * MINUTE;
  for (let i = 0; i < 26 * 60; i++) {
    t += MINUTE;
    const before = zonedParts(t - MINUTE, zone).minutes;
    const here = zonedParts(t, zone).minutes;
    // crossed the named minute (or jumped over it when the clock skips an hour)
    if (here === minutes || (before < minutes && here > minutes && here - before > 1)) return t;
  }
  return t;
}
