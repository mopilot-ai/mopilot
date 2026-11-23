// The spend block of the owner policy (plan U5): its parser, the words both clients show for it, and the day boundary in the owner's time zone. The policy document seeds its block list with `SPEND_BLOCK`.
import { parsePrices } from './prices.mjs';

/** Declared by a Host that totals spend; an end without it is never sent the spend lanes. */
export const SPEND_FEATURE = 'spend';
const MAX_USD = 1_000_000;
const usdOk = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_USD;
const zoneOk = (/** @type {unknown} */ tz) => {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/**
 * The `spend` block: optional limits, the warning share, the owner's time zone and price changes. Unknown keys are dropped.
 * @param {any} raw @param {(m: string) => Error} bad
 */
export function parseSpend(raw, bad) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('Spend settings must be an object.');
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of ['dayUsd', 'chatUsd']) {
    if (raw[k] === undefined || raw[k] === null) continue;
    if (!usdOk(raw[k])) throw bad('A spend limit is an amount in dollars above zero.');
    out[k] = raw[k];
  }
  if (raw.warnAt !== undefined) {
    if (typeof raw.warnAt !== 'number' || !(raw.warnAt > 0 && raw.warnAt < 1)) throw bad('Warn at a share between 0 and 1.');
    out.warnAt = raw.warnAt;
  }
  if (raw.tz !== undefined) {
    if (!zoneOk(raw.tz)) throw bad('Pick a time zone from the list.');
    out.tz = raw.tz;
  }
  if (raw.prices !== undefined) out.prices = parsePrices(raw.prices, bad);
  return out;
}

/** The stricter spend block: the smaller limit of each; everything else stays the owner's. @param {any} owner @param {any} managed */
export function mergeSpend(owner, managed) {
  const out = { ...(owner ?? {}) };
  for (const k of ['dayUsd', 'chatUsd'])
    if (typeof managed?.[k] === 'number') out[k] = Math.min(managed[k], out[k] ?? Number.POSITIVE_INFINITY);
  return out;
}

/** How the policy document reads and merges the `spend` block (shared/host/policy.mjs seeds its block list with it). */
export const SPEND_BLOCK = Object.freeze({ name: 'spend', parse: parseSpend, merge: mergeSpend });

/** The calendar day (`YYYY-MM-DD`) a moment falls on in a time zone; the Host's own zone when none is given. @param {number} ms @param {string} [tz] */
export function dayKey(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const at = (/** @type {string} */ t) => parts.find((p) => p.type === t)?.value;
  return `${at('year')}-${at('month')}-${at('day')}`;
}

/** An amount as both clients say it: always "about", cents under ten dollars. @param {number} usd */
export const aboutUsd = (usd) => `about $${usd < 10 ? usd.toFixed(2) : Math.round(usd)}`;

/** The line a client shows when a limit stopped a turn. @param {'dayUsd' | 'chatUsd'} key @param {number} limitUsd */
export const limitLine = (key, limitUsd) => `Limit reached: ${aboutUsd(limitUsd)} ${key === 'dayUsd' ? 'today' : 'in this chat'}`;
