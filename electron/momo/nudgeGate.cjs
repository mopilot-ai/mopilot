// Which nudge triggers may reach the user now (#2139 P4): nothing while MoMo is off, paused or at proactivity Off, or in quiet hours (they wait for the next check); a `likely` loop is kept but never delivered; the day's quota is the proactivity level's (off 0, low 2, default 6, high 12, counted apart from routine runs), and at most 1 a day for the first 7 days; each dismissal of a kind in the last 30 days adds a day between nudges of that kind; at most MAX_PER_CHECK a check, the soonest due first. Pure: quiet hours and "today" are on the Mac's clock now, so they follow the user's current zone.
const { LIMITS, inQuietHours, localDay } = require('../../shared/momoRoutine.mjs');

const DAY = 86_400_000;
const WEEK_ONE = 7 * DAY;
const DISMISS_WINDOW = 30 * DAY;
/** The most nudges one check delivers. */
const MAX_PER_CHECK = 3;
/** Which trigger goes first when several are due. */
const ORDER = Object.freeze({ due: 0, event: 1, close: 2, stale: 3 });

/**
 * @typedef {import('./nudgeTriggers.cjs').Trigger} Trigger
 * @typedef {{ firstAt?: number, delivered: { at: number, loopId: string, kind: string, trigger: string }[],
 *   dismissed: { at: number, kind: string }[] }} NudgeState what was delivered and dismissed (nudges.json)
 * @typedef {'off' | 'quiet-hours' | 'low-confidence' | 'quota' | 'week-one' | 'dismissed-kind' | 'per-check'} HeldReason
 */

/**
 * @param {Trigger[]} triggers
 * @param {{ now: number, allowed: boolean, settings: { proactivity: string, quietHours: { start: number, end: number } | null, paused: boolean },
 *   state: NudgeState, loops: Map<string, { kind: string, confidence: string }> }} o
 * @returns {{ deliver: Trigger[], held: { trigger: Trigger, reason: HeldReason }[] }}
 */
function gate(triggers, { now, allowed, settings, state, loops }) {
  /** @type {{ trigger: Trigger, reason: HeldReason }[]} */
  const held = [];
  const hold = (/** @type {Trigger[]} */ ts, /** @type {HeldReason} */ reason) => {
    for (const trigger of ts) held.push({ trigger, reason });
    return { deliver: [], held };
  };
  const quota = LIMITS[/** @type {keyof typeof LIMITS} */ (settings.proactivity)]?.runs ?? 0;
  if (!allowed || settings.paused || quota === 0) return hold(triggers, 'off');
  if (inQuietHours(settings.quietHours, now)) return hold(triggers, 'quiet-hours');
  const today = localDay(now);
  const deliveredToday = state.delivered.filter((d) => localDay(d.at) === today).length;
  const weekOne = state.firstAt === undefined || now - state.firstAt < WEEK_ONE;
  const cap = weekOne ? Math.min(quota, 1) : quota;
  const sorted = [...triggers].sort(
    (a, b) => ORDER[a.trigger] - ORDER[b.trigger] || (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER),
  );
  /** @type {Trigger[]} */
  const deliver = [];
  /** @type {Set<string>} kinds given a nudge in this check */
  const kindsNow = new Set();
  for (const t of sorted) {
    const loop = loops.get(t.loopId);
    if (!loop || loop.confidence !== 'sure') {
      held.push({ trigger: t, reason: 'low-confidence' });
      continue;
    }
    const gap = state.dismissed.filter((d) => d.kind === loop.kind && d.at > now - DISMISS_WINDOW).length * DAY;
    const lastOfKind = Math.max(-Infinity, ...state.delivered.filter((d) => d.kind === loop.kind).map((d) => d.at));
    if (gap > 0 && (now - lastOfKind < gap || kindsNow.has(loop.kind))) {
      held.push({ trigger: t, reason: 'dismissed-kind' });
      continue;
    }
    if (deliveredToday + deliver.length >= cap) {
      held.push({ trigger: t, reason: weekOne && cap < quota ? 'week-one' : 'quota' });
      continue;
    }
    if (deliver.length >= MAX_PER_CHECK) {
      held.push({ trigger: t, reason: 'per-check' });
      continue;
    }
    deliver.push(t);
    kindsNow.add(loop.kind);
  }
  return { deliver, held };
}

module.exports = { gate, MAX_PER_CHECK, WEEK_ONE, DISMISS_WINDOW };
