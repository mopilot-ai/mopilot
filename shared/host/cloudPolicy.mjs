// The `cloud` block of a Host's policy document (plan C2): present only in the document the app sends to a cloud machine, and only that Host reads it as "I am a cloud machine". How long it may idle before it stops itself, and how many hours a day it may run; a managed policy's `cloud.idleMinutesMax` and `hoursPerDayMax` lower both.
const IDLE_MINUTES = { min: 1, max: 10_080 };
const HOURS_PER_DAY = { min: 1, max: 24 };
const whole = (/** @type {unknown} */ v, /** @type {{ min: number, max: number }} */ r) =>
  Number.isSafeInteger(v) && /** @type {number} */ (v) >= r.min && /** @type {number} */ (v) <= r.max;

/**
 * @param {any} raw @param {(m: string) => Error} bad
 * @returns {{ idleMinutes?: number, hoursPerDay?: number }}
 */
export function parseCloud(raw, bad) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('Cloud settings must be an object.');
  /** @type {{ idleMinutes?: number, hoursPerDay?: number }} */
  const out = {};
  if (raw.idleMinutes !== undefined) {
    if (!whole(raw.idleMinutes, IDLE_MINUTES)) throw bad(`Stop when idle after ${IDLE_MINUTES.min} to ${IDLE_MINUTES.max} minutes.`);
    out.idleMinutes = raw.idleMinutes;
  }
  if (raw.hoursPerDay !== undefined && raw.hoursPerDay !== null) {
    if (!whole(raw.hoursPerDay, HOURS_PER_DAY)) throw bad(`Hours per day: ${HOURS_PER_DAY.min} to ${HOURS_PER_DAY.max}.`);
    out.hoursPerDay = raw.hoursPerDay;
  }
  return out;
}

/**
 * The stricter block: the smaller of each limit. A Host with no `cloud` block of its own is not a cloud machine, and a managed limit does not make it one.
 * @param {any} owner @param {any} managed
 */
export function mergeCloud(owner, managed) {
  if (!owner) return owner;
  const out = { ...owner };
  for (const k of /** @type {const} */ (['idleMinutes', 'hoursPerDay']))
    if (typeof managed?.[k] === 'number') out[k] = Math.min(managed[k], out[k] ?? Number.POSITIVE_INFINITY);
  return out;
}

export const CLOUD_BLOCK = Object.freeze({ name: 'cloud', parse: parseCloud, merge: mergeCloud });
