// MGB F4 (#1381, macOS cross-app) shared helpers: local wall times on the Mac as UTC ISO, clock and weekday labels,
// the next working day, and the bench's reminders and events looked up by name.
import { dayOffset } from '../seed.mjs';
import { has, same } from '../grade.mjs';

/** A local wall time on a day as UTC ISO, for a Mac whose clock is `tz` minutes east of UTC. @param {string} day @param {number} minutes @param {number} tz */
export const localIso = (day, minutes, tz = 0) => new Date(Date.parse(`${day}T00:00:00Z`) + (minutes - tz) * 60000).toISOString();

/** "09:05" from minutes after midnight. @param {number} m */
export const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** The weekday name of a YYYY-MM-DD day. @param {string} day */
export const weekday = (day) => DAY_NAMES[new Date(`${day}T12:00:00Z`).getUTCDay()];

/** The first Monday-to-Friday day after `day`. @param {string} day YYYY-MM-DD */
export function nextWeekday(day) {
  let d = dayOffset(day, 1);
  while (['Saturday', 'Sunday'].includes(weekday(d))) d = dayOffset(d, 1);
  return d;
}

/** The reminders of one bench list whose name holds `name`. @param {any} mac @param {string} list @param {string} name */
export const remindersIn = (mac, list, name) => mac.reminders.filter((/** @type {any} */ x) => x.list === list && has(x.name, name));

/** Whether an event named like `title` runs exactly from `start` to `end`. @param {any} mac @param {string} title @param {string} start @param {string} end */
export const eventAt = (mac, title, start, end) =>
  mac.events.some((/** @type {any} */ e) => has(e.summary, title) && e.start === start && e.end === end);

/** The first note with exactly this name. @param {any} mac @param {string} name */
export const noteNamed = (mac, name) => mac.notes.find((/** @type {any} */ n) => same(n.name, name));
