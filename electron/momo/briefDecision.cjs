// The morning brief's two decisions as pure functions (A7, design 7.2), so the code decides and the model only writes words: `decide` says whether a brief goes out now (on, allowed, not paused, never in quiet hours, never twice a day, only when the user was active in the last 7 days) and `pick` chooses what it holds (at most ONE attention item with its source, and at most TWO of yesterday's suggestions, three items in all; nothing that clears the bar means no brief). `briefRule` is the daily time it is scheduled at: the end of quiet hours. No clock, disk or Electron here: everything comes in.
const { inQuietHours, localDay } = require('../../shared/momoRoutine.mjs');
const { urgencyOf } = require('./suggestionRank.cjs');

const DAY_MS = 86_400_000;
/** The user must have been active within this many days, today included, or the brief is suspended. */
const AWAY_DAYS = 7;
/** An open loop is an attention item from this long before it is due. */
const DUE_WITHIN_MS = 3 * DAY_MS;
/** What an item must score to be told at all. */
const BAR = 0.1;
const MAX_SUGGESTIONS = 2;
const QUOTE_MAX = 120;
/** The time a brief goes out when there are no quiet hours. */
const DEFAULT_MINUTES = 8 * 60;
/** The words of a suspended brief and of a brief that cannot start. */
const AWAY_TEXT = 'Paused because you were away for a week.';

/** The daily rule at the end of quiet hours (8:00 with none): the scheduler's own RRULE form. @param {{ start: number, end: number } | null} quiet */
function briefRule(quiet) {
  const m = quiet ? quiet.end : DEFAULT_MINUTES;
  return `FREQ=DAILY;BYHOUR=${Math.floor(m / 60)};BYMINUTE=${m % 60};BYSECOND=0`;
}

/**
 * Whether a brief goes out now.
 * @param {{ now: number, enabled: boolean, allowed: boolean, paused: boolean, quietHours: { start: number, end: number } | null,
 *   lastBriefDay: string | null, activeDays: string[] }} o activeDays: the local days the user was active, "2026-11-16"
 * @returns {{ fire: true } | { fire: false, reason: 'off' | 'paused' | 'quiet-hours' | 'already-today' | 'away' }}
 */
function decide({ now, enabled, allowed, paused, quietHours, lastBriefDay, activeDays }) {
  if (!enabled || !allowed) return { fire: false, reason: 'off' };
  if (paused) return { fire: false, reason: 'paused' };
  if (inQuietHours(quietHours, now)) return { fire: false, reason: 'quiet-hours' };
  if (lastBriefDay === localDay(now)) return { fire: false, reason: 'already-today' };
  if (!awayOk(activeDays, now)) return { fire: false, reason: 'away' };
  return { fire: true };
}

/** Whether the user was active in the last AWAY_DAYS days (today included). */
function awayOk(/** @type {string[]} */ activeDays, /** @type {number} */ now) {
  const oldest = localDay(now - (AWAY_DAYS - 1) * DAY_MS);
  return activeDays.some((d) => d >= oldest);
}

const clip = (/** @type {unknown} */ v, /** @type {number} */ n) => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return s.length > n ? `${[...s].slice(0, n - 1).join('')}…` : s;
};

/**
 * What the brief holds.
 * @param {object} o
 * @param {number} o.now
 * @param {{ id: string, text: string, quote?: string, state: string, saidAt: number, dueAt?: number, snoozedUntil?: number }[]} o.loops
 * @param {{ id: string, title: string, source: string, kind: 'card' | 'run' }[]} o.needs tasks in Needs you or Didn't finish, each with its source line
 * @param {{ id: string, title: string, source: string, status: string, createdAt: number, score: { total: number } }[]} o.suggestions the live suggestions
 * @returns {{ attention: { kind: 'loop' | 'card' | 'run', id: string, title: string, source: string, quote: string | null } | null,
 *   suggestions: { id: string, title: string, source: string }[] }}
 */
function pick({ now, loops, needs, suggestions }) {
  const soon = now + DUE_WITHIN_MS;
  /** @type {{ score: number, item: NonNullable<ReturnType<typeof pick>['attention']> }[]} */
  const candidates = [];
  for (const l of loops) {
    if (l.state !== 'open' || (typeof l.snoozedUntil === 'number' && l.snoozedUntil > now)) continue;
    if (typeof l.dueAt !== 'number' || l.dueAt > soon) continue;
    candidates.push({
      score: urgencyOf(l.dueAt, now) * 0.9,
      item: {
        kind: 'loop',
        id: l.id,
        title: clip(l.text, 120),
        source: `Your promise, ${localDay(l.saidAt)}`,
        quote: clip(l.quote, QUOTE_MAX) || null,
      },
    });
  }
  for (const n of needs)
    candidates.push({
      score: n.kind === 'card' ? 0.95 : 0.6,
      item: { kind: n.kind, id: n.id, title: clip(n.title, 120), source: clip(n.source, 100), quote: null },
    });
  // the best one; the same score keeps the order the sources gave
  const best = candidates.filter((c) => c.score >= BAR).sort((a, b) => b.score - a.score)[0];
  // yesterday's: told before today began and still waiting for the user
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const picked = suggestions
    .filter((s) => s.status === 'new' && s.createdAt < dayStart && s.score.total >= BAR)
    .sort((a, b) => b.score.total - a.score.total || a.id.localeCompare(b.id))
    .slice(0, MAX_SUGGESTIONS)
    .map((s) => ({ id: s.id, title: s.title, source: s.source }));
  return { attention: best?.item ?? null, suggestions: picked };
}

module.exports = { decide, pick, briefRule, awayOk, AWAY_TEXT, AWAY_DAYS, BAR, MAX_SUGGESTIONS, DUE_WITHIN_MS };
