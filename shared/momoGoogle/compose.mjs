// The Google part of MoMo's home view (shared/momoView.ts): the Sources rows of the home and the Google line of first-run setup, from what the home's Google service says, for the device's composition to merge into its view.
import { causeOf, setupGoogleOf, sourcesOf } from './view.mjs';

/**
 * Pure: the view parts of one Google state.
 * @param {import('./state.mjs').GoogleState} state
 * @param {{ progress?: { done: number, total: number } | null, lastAttemptFailed?: boolean }} [o]
 */
export function googleViewOf(state, { progress = null, lastAttemptFailed = false } = {}) {
  return { state, sources: sourcesOf(state, progress), setupGoogle: setupGoogleOf(state, lastAttemptFailed), cause: causeOf(state) };
}

/**
 * Asks the home's Host for the Google state and returns its view parts; a Host that cannot be reached or does not serve Google yet shows nothing connected,
 * never an error in the middle of the whole view.
 * @param {object} o
 * @param {(method: string, params: object) => Promise<unknown>} o.call a call to the home's Host
 * @param {{ done: number, total: number } | null} [o.progress] the first look at the last 30 days, while it runs
 * @param {boolean} [o.lastAttemptFailed] the last sign-in on this device ended in something the person can fix
 */
export async function composeGoogle({ call, progress = null, lastAttemptFailed = false }) {
  try {
    const state = /** @type {import('./state.mjs').GoogleState} */ (await call('host.momoGoogle', { op: 'status' }));
    return { reachable: true, ...googleViewOf(state, { progress, lastAttemptFailed }) };
  } catch {
    return { reachable: false, ...googleViewOf({ kind: 'not_connected', canStart: false, iosRedirectUri: null }, { lastAttemptFailed }) };
  }
}
