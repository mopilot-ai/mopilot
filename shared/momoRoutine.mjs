// MoMo's Routines rules (#2139): the settings (quiet hours, proactivity, MoMo paused), whether a run may start now, a schedule given as a time and days as its RRULE, and the scheduler task each routine becomes. Pure, so main and Settings agree.

import { prefixUnits } from './textPrefix.mjs';

/** The kind of MoMo task the app's scheduler runs beside the user's scheduled tasks. */
export const ROUTINE = 'momo-routine';

/** A routine or its run that isn't valid, as its writer is told. */
export class RoutineError extends Error {
  /** @param {string} message @param {'bad_args' | 'full' | 'unavailable' | 'not_found' | 'changed'} code */
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** How much MoMo does on its own, least first. */
export const PROACTIVITY = /** @type {const} */ (['off', 'low', 'default', 'high']);

/** Per level: routine runs a day. Off runs nothing. */
export const LIMITS = Object.freeze({
  off: { runs: 0 },
  low: { runs: 2 },
  default: { runs: 6 },
  high: { runs: 12 },
});

/** Minutes after local midnight. */
const DEFAULT_QUIET = Object.freeze({ start: 22 * 60, end: 7 * 60 });

const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** "HH:MM" (24-hour) as minutes after midnight, or null. */
export function parseClock(v) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(typeof v === 'string' ? v.trim() : '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * MoMo's routine settings from the app's prefs (prefs.momo.routines, prefs.momo.paused), with
 * the defaults for what is missing or not valid. quietHours null: none; paused: MoMo is
 * paused (Settings › MoMo), so nothing runs.
 * @returns {{ proactivity: typeof PROACTIVITY[number], quietHours: { start: number, end: number } | null, paused: boolean }}
 */
export function routineSettings(prefs) {
  const momo = record(record(prefs).momo);
  const r = record(momo.routines);
  const proactivity = PROACTIVITY.includes(r.proactivity) ? r.proactivity : 'default';
  /** @type {{ start: number, end: number } | null} */
  let quietHours = { ...DEFAULT_QUIET };
  if (r.quietHours === null) quietHours = null;
  else if (Object.hasOwn(r, 'quietHours')) {
    const q = record(r.quietHours);
    const start = parseClock(q.start);
    const end = parseClock(q.end);
    // start and end the same names no quiet time at all
    if (start !== null && end !== null) quietHours = start === end ? null : { start, end };
  }
  return { proactivity, quietHours, paused: momo.paused === true };
}

/** Minutes after local midnight at `at`, on the computer's clock (its time zone, daylight saving included). */
const minutesAt = (at) => {
  const d = new Date(at);
  return d.getHours() * 60 + d.getMinutes();
};

/** Whether `at` falls in quiet hours, which may run past midnight (22:00–07:00). */
export function inQuietHours(quietHours, at) {
  if (!quietHours) return false;
  const m = minutesAt(at);
  const { start, end } = quietHours;
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/** The local day of `at` ("2030-03-10"): the day a routine's runs are counted on. */
export function localDay(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The days a weekly routine may name, Monday first (RRULE BYDAY). */
export const WEEKDAYS = Object.freeze(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);

/**
 * A routine's schedule as an RRULE: the rule given, or a time ("09:00") every day or on the days named ("MO", "Monday").
 * What can't be one is said in words the agent can act on. The rule itself is checked again where routines are kept
 * (routineStore.cjs: it parses, and runs at most hourly).
 * @param {{ rrule?: unknown, time?: unknown, days?: unknown }} s
 * @returns {{ ok: true, rrule: string } | { ok: false, error: string }}
 */
export function routineRule(s) {
  const r = record(s);
  const rule = typeof r.rrule === 'string' ? r.rrule.trim() : '';
  const timed = r.time !== undefined && r.time !== null && r.time !== '';
  const named = Array.isArray(r.days) ? r.days.length > 0 : r.days !== undefined && r.days !== null;
  if (rule && (timed || named)) return { ok: false, error: 'Give either an RRULE or a time with days, not both.' };
  if (rule) return { ok: true, rrule: rule };
  if (!timed) return { ok: false, error: 'Give the schedule: a time ("09:00") with optional days, or an RRULE.' };
  const at = parseClock(r.time);
  if (at === null) return { ok: false, error: `Not a time: ${String(r.time)}. Use 24-hour HH:MM.` };
  const time = `BYHOUR=${Math.floor(at / 60)};BYMINUTE=${at % 60};BYSECOND=0`;
  if (!named) return { ok: true, rrule: `FREQ=DAILY;${time}` };
  const days = Array.isArray(r.days) ? r.days.map((d) => (typeof d === 'string' ? d.trim().slice(0, 2).toUpperCase() : '')) : [''];
  if (days.some((d) => !WEEKDAYS.includes(d))) return { ok: false, error: `Days are ${WEEKDAYS.join(', ')}.` };
  const set = WEEKDAYS.filter((d) => days.includes(d));
  return { ok: true, rrule: set.length === WEEKDAYS.length ? `FREQ=DAILY;${time}` : `FREQ=WEEKLY;BYDAY=${set.join(',')};${time}` };
}

/**
 * A rule routineRule makes back as its time and days ({ time: "09:00", days: [] } every day), for the edit form; null
 * for any other rule (it is edited as an RRULE).
 * @returns {{ time: string, days: string[] } | null}
 */
export function ruleParts(rrule) {
  /** @type {Record<string, string>} */
  const parts = {};
  for (const p of String(rrule ?? '')
    .replace(/^RRULE:/, '')
    .split(';')) {
    const [k, v, ...rest] = p.split('=');
    if (!k || v === undefined || rest.length || Object.hasOwn(parts, k)) return null;
    parts[k] = v;
  }
  const { FREQ, BYDAY, BYHOUR, BYMINUTE = '0', BYSECOND = '0', ...other } = parts;
  const hour = /^\d{1,2}$/.test(BYHOUR ?? '') ? Number(BYHOUR) : 24;
  const minute = /^\d{1,2}$/.test(BYMINUTE) ? Number(BYMINUTE) : 60;
  if (Object.keys(other).length || BYSECOND !== '0' || hour > 23 || minute > 59) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(hour)}:${pad(minute)}`;
  if (FREQ === 'DAILY' && BYDAY === undefined) return { time, days: [] };
  const days = (BYDAY ?? '').split(',');
  if (FREQ !== 'WEEKLY' || days.some((d) => !WEEKDAYS.includes(d))) return null;
  return { time, days: WEEKDAYS.filter((d) => days.includes(d)) };
}

/**
 * Whether a MoMo routine's run may start at `at`, and why not. Not allowed comes first: nothing else is decided for an
 * account MoMo is off for; then MoMo paused.
 * @param {{ at: number, settings: ReturnType<typeof routineSettings>, allowed: boolean, runsToday: number,
 *   approved?: boolean }} o  approved: the user approved the routine; unsaid, it isn't (a routine never runs on a missing answer)
 * @returns {{ ok: true } | { ok: false, reason: 'not-allowed' | 'paused' | 'off' | 'not-approved' | 'quiet-hours' | 'limit' }}
 */
export function runDecision({ at, settings, allowed, runsToday, approved = false }) {
  if (!allowed) return { ok: false, reason: 'not-allowed' };
  if (settings.paused) return { ok: false, reason: 'paused' };
  if (settings.proactivity === 'off') return { ok: false, reason: 'off' };
  if (!approved) return { ok: false, reason: 'not-approved' };
  if (inQuietHours(settings.quietHours, at)) return { ok: false, reason: 'quiet-hours' };
  if (runsToday >= LIMITS[settings.proactivity].runs) return { ok: false, reason: 'limit' };
  return { ok: true };
}

/** A MoMo task id: "momo." and an opaque id, which no scheduled task the app or the Codex app makes can have. */
export const momoTaskId = (id) => `momo.${id}`;
export const isMomoTaskId = (id) => typeof id === 'string' && /^momo\.[A-Za-z0-9_-]+$/.test(id);

/** The first paragraph of a reply, at most `max` characters: what a routine tells MoMo's chat. */
export function onePara(text, max = 600) {
  const flat = String(text ?? '')
    .trim()
    .split(/\n\s*\n/)[0]
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${prefixUnits(flat, max - 1).trimEnd()}…` : flat;
}
