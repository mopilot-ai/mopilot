// The brief settings, notification permission and delivery problems in the shape of the shared view contract (shared/momoView.ts MomoSettingsView, MomoSetupView.notifications): one pure projection of what the home's prefs, its day and its push report, so the Mac and the phone draw the same words and the same one-tap fixes.

/** The brief's default time and the quiet hours' default window (design D1). */
export const BRIEF_TIME = '08:00';
export const QUIET_DEFAULT = Object.freeze({ from: '22:00', to: '08:00' });
/** Tell-now pushes a day unless the owner says otherwise (design D2). */
export const TELL_NOW_DEFAULT = 6;

/**
 * @typedef {{ id: string, label: string }} DeliveryFix the one tap that fixes a problem (`open_settings` opens the phone's Settings, `pair_again` the pairing, `retry` sends again, `show_brief_now` makes the day's brief)
 * @typedef {{ id: string, code: string, cause: string, fix: DeliveryFix, since: number | null }} DeliveryProblem
 * @typedef {{ brief: { on: boolean, time: string }, quietHours: { from: string, to: string }, dailyCap: number, previews: boolean }} MomoSettingsView
 */

const clock = (/** @type {unknown} */ v, /** @type {string} */ fallback) =>
  typeof v === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v) ? v.padStart(5, '0') : fallback;

/**
 * Settings as the settings page draws them. Quiet hours turned off read as the same time twice, which the page shows as "Off".
 * @param {any} prefs `prefs.momo` as the Host keeps it (`momo.prefs.forRoutines()`)
 * @returns {MomoSettingsView}
 */
export function momoSettingsView(prefs) {
  const momo = prefs?.momo ?? {};
  const q = momo.routines?.quietHours;
  const quietHours =
    q === null ? { from: '00:00', to: '00:00' } : { from: clock(q?.start, QUIET_DEFAULT.from), to: clock(q?.end, QUIET_DEFAULT.to) };
  const cap = momo.notify?.tellNowMax;
  return {
    brief: { on: momo.brief?.on === true, time: clock(momo.brief?.time, BRIEF_TIME) },
    quietHours,
    dailyCap: Number.isInteger(cap) && cap >= 1 ? cap : TELL_NOW_DEFAULT,
    previews: momo.notify?.previews === true,
  };
}

const BRIEF_PROBLEMS = /** @type {Record<string, { cause: string, fix: DeliveryFix }>} */ ({
  brief_failed: { cause: "Couldn't start your brief.", fix: { id: 'show_brief_now', label: 'Show it now' } },
  brief_missed_asleep: {
    cause: "Couldn't start your brief. The home was asleep at the brief time.",
    fix: { id: 'show_brief_now', label: 'Show it now' },
  },
});

/**
 * @param {object} o
 * @param {any} o.prefs
 * @param {{ failure: { code: string } | null } | null | undefined} o.day `momo.daily.status()`
 * @param {{ pairId: string, code: string, since: number, id: string, label: string, cause: string }[]} o.pushProblems `momo.push.failures()`
 * @param {boolean} o.reachedAPhone a push was ever sent to a phone
 * @returns {{ settings: MomoSettingsView, notifications: 'unknown' | 'allowed' | 'denied', problems: DeliveryProblem[] }}
 */
export function momoDeliveryView({ prefs, day, pushProblems, reachedAPhone }) {
  /** @type {DeliveryProblem[]} */
  const problems = pushProblems.map((p) => ({
    id: `push:${p.pairId}`,
    code: p.code,
    cause: p.cause,
    fix: { id: p.id, label: p.label },
    since: p.since,
  }));
  const brief = day?.failure ? BRIEF_PROBLEMS[day.failure.code] : null;
  if (day?.failure && brief)
    problems.unshift({ id: `day:${day.failure.code}`, code: day.failure.code, cause: brief.cause, fix: brief.fix, since: null });
  // "denied" is what the phone told us (no token on a phone that never had one); one that was reached is allowed; otherwise nobody knows yet
  const denied = pushProblems.some((p) => p.code === 'notifications_off');
  return { settings: momoSettingsView(prefs), notifications: denied ? 'denied' : reachedAPhone ? 'allowed' : 'unknown', problems };
}
