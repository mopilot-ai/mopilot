// The shapes of what the Host keeps in MoMo's folder for itself (home lane): the grant and the home record, read from their sealed files with anything malformed taken as the empty value, and how many ended moves an old home remembers. Pure: the home (./momoHome.mjs) opens the files.

/** How many ended moves' ids an old home remembers, so a late or repeated step of one cannot pause it again. */
export const CLOSED_KEEP = 20;

/** @typedef {{ account: string | null, features: string[], receivedAt: number }} Grant */
/**
 * The home record (design 3.1): `leaseEpoch` is the fencing token, +1 on every move; only the Host holding the current one acts.
 * `state` is what this Host keeps: 'none', 'running' or 'moving' (a Host that is asleep, out of date or signed out cannot say so; the
 * client derives those, shared/momoHomeState.mjs).
 * @typedef {{ homeId: string | null, leaseEpoch: number, state: 'none' | 'running' | 'moving', stateSince: number, lastSeenAt: number, moveId: string | null, bundleHash: string | null, moveDeadline: number | null, targetSignKey: string | null, moveReceipts: Record<string, { leaseEpoch: number, receipt: string }>, closedMoves: string[], movedTo: { name: string, homeId: string, at: number } | null, retired: { at: number, lastActive: number } | null, name: string, account: string | null }} HomeRecord
 */
/** @typedef {{ homeId: string, leaseEpoch: number }} HomeStamp what every outbound action and push of the home carries */

/** @param {any} v @returns {Grant} */
export const grantShape = (v) => ({
  account: typeof v?.account === 'string' ? v.account : null,
  features: Array.isArray(v?.features) ? v.features.filter((/** @type {unknown} */ f) => typeof f === 'string') : [],
  receivedAt: Number.isFinite(v?.receivedAt) ? v.receivedAt : 0,
});
/** The target's receipts of the switches it made, by move id, newest last: kept past later moves and restarts, so a repeat of a switch or a discard that finds one tells the same. @param {any} v @returns {Record<string, { leaseEpoch: number, receipt: string }>} */
const receiptsOf = (v) =>
  Object.fromEntries(
    Object.entries(v && typeof v === 'object' && !Array.isArray(v) ? v : {})
      .filter(([, r]) => Number.isSafeInteger(/** @type {any} */ (r)?.leaseEpoch) && typeof (/** @type {any} */ (r)?.receipt) === 'string')
      .slice(-CLOSED_KEEP)
      .map(([id, r]) => [id, { leaseEpoch: /** @type {any} */ (r).leaseEpoch, receipt: /** @type {any} */ (r).receipt }]),
  );

/** @param {any} v @returns {HomeRecord} */
export const homeShape = (v) => ({
  homeId: typeof v?.homeId === 'string' ? v.homeId : null,
  leaseEpoch: Number.isSafeInteger(v?.leaseEpoch) && v.leaseEpoch > 0 ? v.leaseEpoch : 0,
  state: v?.state === 'running' || v?.state === 'moving' ? v.state : 'none',
  stateSince: Number.isFinite(v?.stateSince) ? v.stateSince : 0,
  lastSeenAt: Number.isFinite(v?.lastSeenAt) ? v.lastSeenAt : 0,
  moveId: typeof v?.moveId === 'string' ? v.moveId : null,
  bundleHash: typeof v?.bundleHash === 'string' ? v.bundleHash : null,
  moveDeadline: Number.isFinite(v?.moveDeadline) ? v.moveDeadline : null,
  moveReceipts: receiptsOf(v?.moveReceipts),
  closedMoves: Array.isArray(v?.closedMoves)
    ? v.closedMoves.filter((/** @type {unknown} */ i) => typeof i === 'string').slice(-CLOSED_KEEP)
    : [],
  targetSignKey: typeof v?.targetSignKey === 'string' ? v.targetSignKey : null,
  movedTo:
    typeof v?.movedTo?.name === 'string' && typeof v.movedTo.homeId === 'string' && Number.isFinite(v.movedTo.at)
      ? { name: v.movedTo.name, homeId: v.movedTo.homeId, at: v.movedTo.at }
      : null,
  retired: Number.isFinite(v?.retired?.at)
    ? { at: v.retired.at, lastActive: Number.isFinite(v.retired.lastActive) ? v.retired.lastActive : v.retired.at }
    : null,
  name: typeof v?.name === 'string' ? v.name : '',
  account: typeof v?.account === 'string' ? v.account : null,
});
