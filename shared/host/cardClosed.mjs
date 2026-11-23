// What a card a Host closed says, read by both clients from the one journal item the Host writes when a card closes (`permissionCancelled`: why, who answered, the option, the turn): "Allowed on Pocket iPhone", "Not answered", "Cancelled", "The machine restarted", in the words of cardLine.mjs. The Mac's transcript and the phone's rows place the line in the item's turn.
import { cardLine } from './cardLine.mjs';

const STATE = /** @type {Record<string, string>} */ ({
  expired: 'expired',
  stopped: 'stopped',
  turn_ended: 'turn_ended',
  host_restarted: 'restarted',
});

/**
 * The line of a closed card, or null: nothing for a Host that sends no reason (an older one), nothing for an answer given from this device itself (its card already showed it), nothing for an answer from nowhere known.
 * @param {any} event a `permissionCancelled` item
 * @param {{ selfKey?: string | null, machineName?: string, now?: number }} [o] `selfKey`: this app's client key, whose answers are not "on another device"
 * @returns {string | null}
 */
export function closedLine(event, { selfKey = null, machineName, now = Date.now() } = {}) {
  const reason = event?.reason;
  if (typeof reason !== 'string') return null;
  if (reason === 'answered') {
    const by = event.answeredBy;
    const name = typeof by?.name === 'string' && by.name ? by.name : null;
    if (!name || (selfKey && by.fingerprint === selfKey)) return null;
    const optionKind = event.optionKind === 'allow' || event.optionKind === 'deny' ? event.optionKind : 'other';
    return cardLine({ state: 'answered', optionKind, by: { name, ...(typeof event.at === 'number' ? { at: event.at } : {}) } }, { now })
      .text;
  }
  const state = STATE[reason];
  return state ? cardLine(/** @type {any} */ ({ state }), { now, machineName }).text : null;
}
