// MoMo's Google source as the clients' view contract sees it (shared/momoView.ts): the Sources rows of Settings, the Google state of first-run setup, and the intents (connect, reconnect, grant send, remove) a client sends the home. Pure of any platform: `momo.home.view` fills `sources` and `setup.google` with these, and `momo.home.intent` runs `runGoogleIntent`.
import { disconnectGoogle, signInToGoogle } from './signIn.mjs';

/** The intents a client may send for Google. A newer client may send one this file does not know: it is answered, never run. */
export const GOOGLE_INTENTS = Object.freeze(['connect', 'reconnect', 'grant-send', 'remove']);

/**
 * Gmail and Calendar rows for `MomoSourceView[]`: one per source, empty while nothing is connected.
 * @param {import('./state.mjs').GoogleState} state @param {{ done: number, total: number } | null} [progress] the first look at the last 30 days, while it runs
 */
export function sourcesOf(state, progress = null) {
  if (state.kind === 'not_connected' || state.kind === 'connecting') return [];
  const rows = (/** @type {string} */ access, /** @type {string} */ status) =>
    ['gmail', 'calendar'].map((id) => ({ id, account: state.email, access, status, progress: status === 'catching-up' ? progress : null }));
  if (state.kind === 'disconnected') return rows('read-only', 'needs-reconnect');
  const access = state.kind === 'send_granted' ? 'read-and-ask' : 'read-only';
  return rows(access, progress ? 'catching-up' : 'ok');
}

/**
 * The Google line of `MomoSetupView`: waiting while a sign-in is open, failed when the last attempt ended in something the person can fix.
 * @param {import('./state.mjs').GoogleState} state @param {boolean} lastAttemptFailed
 * @returns {'idle' | 'waiting' | 'connected' | 'failed'}
 */
export function setupGoogleOf(state, lastAttemptFailed) {
  if (state.kind === 'connected_read_only' || state.kind === 'send_granted') return 'connected';
  if (state.kind === 'connecting') return 'waiting';
  return state.kind === 'disconnected' || lastAttemptFailed ? 'failed' : 'idle';
}

/** Why the source is disconnected (`revoked`, `testing_expired`, ...), for the copy beside "needs you to sign in again"; null otherwise. @param {import('./state.mjs').GoogleState} state */
export const causeOf = (state) => (state.kind === 'disconnected' ? state.cause : null);

/**
 * Runs one Google intent against the home. `connect` and `reconnect` are the same sign-in (a reconnect after an ended grant starts over), `grant-send`
 * is the separate send-only step, `remove` revokes and erases.
 * @param {object} o
 * @param {string} o.intent
 * @param {import('./signIn.mjs').GoogleHost} o.host
 * @param {() => Promise<import('./signIn.mjs').Catcher>} o.startCatcher
 * @param {import('./seal.mjs').Sealer} o.sealer
 * @param {'desktop' | 'ios'} o.client which OAuth client this device signs in with
 * @returns {Promise<import('./signIn.mjs').SignInResult | { ok: true, state: import('./state.mjs').GoogleState, revoked: boolean }>}
 */
export async function runGoogleIntent({ intent, host, startCatcher, sealer, client }) {
  if (intent === 'connect' || intent === 'reconnect') return signInToGoogle({ host, startCatcher, sealer, purpose: 'read', client });
  if (intent === 'grant-send') return signInToGoogle({ host, startCatcher, sealer, purpose: 'send', client });
  if (intent === 'remove') return disconnectGoogle(host);
  return { ok: false, code: 'unknown_intent', message: 'That is not something MoMo can do with Google.' };
}
