// Motion bench statistics: quantiles, medians and rounding the cursor, alignment, jank and cost analyses share.

/** The `q` quantile (0–1) of numbers by nearest rank, or null for none. */
export function quantile(/** @type {number[]} */ values, /** @type {number} */ q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/** The median of numbers (the mean of the middle two for an even count), or null for none. */
export function median(/** @type {number[]} */ values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/**
 * A number rounded to `places` decimals; null stays null.
 * @overload
 * @param {number} value
 * @param {number} [places]
 * @returns {number}
 */
/**
 * @overload
 * @param {number | null} value
 * @param {number} [places]
 * @returns {number | null}
 */
/**
 * @param {number | null} value
 * @param {number} [places]
 */
export function round(value, places = 1) {
  if (value === null) return null;
  const k = 10 ** places;
  return Math.round(value * k) / k;
}

/** Root mean square of numbers, or null for none. */
export function rms(/** @type {number[]} */ values) {
  return values.length ? Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length) : null;
}

/** Spread of intervals: p50, p95, max and the p95 - p50 jitter, in the unit given; nulls for none. */
export function spread(/** @type {number[]} */ values) {
  const p50 = quantile(values, 0.5);
  const p95 = quantile(values, 0.95);
  return {
    count: values.length,
    p50: round(p50),
    p95: round(p95),
    max: values.length ? round(Math.max(...values)) : null,
    jitter: p50 === null || p95 === null ? null : round(p95 - p50),
  };
}
