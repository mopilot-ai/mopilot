// Request ledger lines to usage and cost at list price (shared/host/prices.mjs): the one aggregation every cost surface reads, so the
// Settings totals, the request log's column and a chat's own estimate agree. A cost here is an estimate of what the requests would
// cost on API keys, whatever actually paid for them; a model with no list price is counted as unpriced, never as free.
import { costOf, priceFor } from './host/prices.mjs';

/**
 * Usage of one day, harness, model and way of paying.
 * @typedef {{ day: string, harness: string, model: string | null, pay: string, requests: number,
 *   in: number, out: number, cacheRead: number, cacheWrite: number }} UsageRow
 * @typedef {UsageRow & { usd: number | null }} PricedRow `usd` is null when the model has no list price
 */

const n = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** The model a line is priced as: the one that answered, else the one asked for (Codex names the one that answered only when it reroutes). @param {any} line */
export function modelOfLine(line) {
  for (const m of [line?.served, line?.req]) if (typeof m === 'string' && m) return m;
  return null;
}

/** Whether a ledger line is a model request with tokens to count: not a computer-access call, a cap marker, or a request that reported none. @param {any} line */
export function countsUsage(line) {
  if (!line || typeof line !== 'object' || line.capped || line.kind || typeof line.harness !== 'string') return false;
  return n(line.in) + n(line.out) + n(line.cacheRead) + n(line.cacheWrite) > 0;
}

const rowKey = (/** @type {Pick<UsageRow, 'day' | 'harness' | 'model' | 'pay'>} */ r) => JSON.stringify([r.day, r.harness, r.model, r.pay]);

/**
 * Rows of usage summed from `lines` that fall on `day` (a ledger day file's lines), or each on the day `dayOf` names.
 * @param {any[]} lines @param {string | ((line: any) => string)} day
 * @returns {UsageRow[]}
 */
export function usageRows(lines, day) {
  /** @type {Map<string, UsageRow>} */
  const rows = new Map();
  for (const line of lines) {
    if (!countsUsage(line)) continue;
    const r = {
      day: typeof day === 'function' ? day(line) : day,
      harness: line.harness,
      model: modelOfLine(line),
      pay: typeof line.pay === 'string' ? line.pay : 'unknown',
    };
    const k = rowKey(r);
    const row = rows.get(k) ?? { ...r, requests: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    row.requests += 1;
    row.in += n(line.in);
    row.out += n(line.out);
    row.cacheRead += n(line.cacheRead);
    row.cacheWrite += n(line.cacheWrite);
    rows.set(k, row);
  }
  return [...rows.values()];
}

/** Rows of the same day, harness, model and payment added together. @param {UsageRow[]} rows @returns {UsageRow[]} */
export function mergeRows(rows) {
  /** @type {Map<string, UsageRow>} */
  const out = new Map();
  for (const r of rows) {
    const k = rowKey(r);
    const m = out.get(k);
    if (!m) out.set(k, { ...r });
    else for (const f of /** @type {const} */ (['requests', 'in', 'out', 'cacheRead', 'cacheWrite'])) m[f] += n(r[f]);
  }
  return [...out.values()];
}

/** Whether `v` is a usage row as a stored rollup keeps it. @param {unknown} v @returns {v is UsageRow} */
export function isUsageRow(v) {
  const r = /** @type {any} */ (v);
  return (
    !!r &&
    typeof r === 'object' &&
    typeof r.day === 'string' &&
    typeof r.harness === 'string' &&
    (r.model === null || typeof r.model === 'string') &&
    typeof r.pay === 'string' &&
    ['requests', 'in', 'out', 'cacheRead', 'cacheWrite'].every((f) => typeof r[f] === 'number' && Number.isFinite(r[f]) && r[f] >= 0)
  );
}

/**
 * Each row with its cost at list price, the owner's prices over the shipped ones.
 * @param {UsageRow[]} rows @param {Record<string, import('./host/prices.mjs').Price>} [owner]
 * @returns {PricedRow[]}
 */
export function pricedRows(rows, owner) {
  return rows.map((r) => ({
    ...r,
    usd: costOf(
      { inputTokens: r.in, outputTokens: r.out, cachedReadTokens: r.cacheRead, cachedWriteTokens: r.cacheWrite },
      priceFor(r.model, owner),
    ),
  }));
}

/** One ledger line's cost at list price, or null when it is no priced request. @param {any} line @param {Record<string, import('./host/prices.mjs').Price>} [owner] */
export function lineUsd(line, owner) {
  if (!countsUsage(line)) return null;
  return costOf(
    { inputTokens: line.in, outputTokens: line.out, cachedReadTokens: line.cacheRead, cachedWriteTokens: line.cacheWrite },
    priceFor(modelOfLine(line), owner),
  );
}
