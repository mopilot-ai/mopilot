// Admission a client can read: the close code each refusal is answered with (a full relay, an account at its device cap, an
// account whose relay access is switched off), and the account switch itself, set by the account service's signed request.
import { afterTick } from './liveness.mjs';

/** @typedef {import('./hub.mjs').Hub} Hub */
/** @typedef {import('./connection.mjs').Identity} Identity */

/** The relay holds MAX_CONNECTIONS sockets: come back later, with a wait that grows. */
export const CLOSE_CAPACITY = 4503;
/** The account already has MAX_CONNECTIONS_PER_ACCOUNT devices connected. */
export const CLOSE_ACCOUNT_LIMIT = 4429;
/** The account's relay access is switched off at the account service. */
export const CLOSE_DISABLED = 4423;

/** @typedef {'restarting' | 'busy' | 'account_limit' | 'account_disabled'} Refusal */

/** @type {Record<Refusal, [number, string]>} */
const CLOSES = {
  restarting: [1012, 'restarting'],
  busy: [CLOSE_CAPACITY, 'capacity'],
  account_limit: [CLOSE_ACCOUNT_LIMIT, 'account_limit'],
  account_disabled: [CLOSE_DISABLED, 'account_disabled'],
};

/** The close code and reason a refusal is answered with. @param {Refusal} refusal */
export const closeOf = (refusal) => CLOSES[refusal];

/** The reasons counted in `relay_connections_refused_total`, so a scrape shows each at 0 before its first refusal. */
export const REFUSAL_REASONS = /** @type {Refusal[]} */ (Object.keys(CLOSES));
export const REFUSED_HELP = 'Sockets the relay refused, by reason';

/** Counts a refusal. @param {Hub} hub @param {Refusal} reason */
export const countRefusal = (hub, reason) => hub.metrics.inc('relay_connections_refused_total', { reason }, 1, REFUSED_HELP);

/**
 * Whether the identity's account is switched off. The account service refuses a switched-off account its relay token, so a token
 * issued after the switch-off the relay holds shows the account was switched on again and the relay was not told: the record
 * goes and the device is let in. A Host shows no account token, so it waits for the account service's word or for a device's.
 * @param {Hub} hub @param {Identity} identity
 */
export async function accountDisabled(hub, identity) {
  const at = await hub.store.disabledAt(identity.userId);
  if (at === null) return false;
  if (identity.kind === 'host' || !(Number(identity.iatMs) > at)) return true;
  await hub.store.enableAccount(identity.userId, Number(identity.iatMs) - 1);
  hub.log('account_access', { code: 'enabled_by_token' });
  return false;
}

/**
 * A socket that has just joined the hub whose account is switched off: it leaves again, closed with CLOSE_DISABLED. Resolves whether it was.
 * @param {Hub} hub @param {import('./connection.mjs').Conn} conn
 */
export async function refusedDisabled(hub, conn) {
  if (!(await accountDisabled(hub, conn.identity))) return false;
  hub.conns.delete(conn.identity.deviceId);
  countRefusal(hub, 'account_disabled');
  hub.drop(conn, ...closeOf('account_disabled'));
  return true;
}

/**
 * The account service switched an account's relay access off or on (POST /v1/account/access). Off: the record is kept, so no
 * socket of the account is admitted again, and every socket it has now (devices, host lanes and Hosts) is closed with
 * CLOSE_DISABLED, and the frames stored for its pairs are deleted; its pairs and Host credentials stay, for the day it is switched
 * on again. Safe to repeat.
 * @param {Hub} hub @param {{ userId: string, disabled: boolean, atMs: number }} change `atMs`: when the account service made it
 * @returns {Promise<{ sockets: number, frames: number }>} how many sockets were closed and stored frames deleted
 */
export async function setAccountAccess(hub, { userId, disabled, atMs }) {
  if (!disabled) {
    await hub.store.enableAccount(userId, atMs);
    hub.log('account_access', { code: 'enabled' });
    return { sockets: 0, frames: 0 };
  }
  await hub.store.disableAccount(userId, atMs);
  let sockets = 0;
  for (const conn of [...hub.all]) {
    if (conn.identity.userId !== userId || conn.closed) continue;
    sockets++;
    hub.drop(conn, CLOSE_DISABLED, 'account_disabled');
    // its peers hear it left now, not when its socket's close arrives
    afterTick(hub, conn, CLOSE_DISABLED);
  }
  // what the relay stores for the account goes, once its sockets can store no more: an account switched off for filling the mailbox
  // gives the room back at once
  const frames = (await hub.store.clearMailboxes(userId)) + ((await hub.mailbox?.clearAccount(userId)) ?? 0);
  hub.log('account_access', { code: 'disabled', sockets });
  return { sockets, frames };
}
